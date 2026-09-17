//! 进程管理命令：spawn、write、kill、list、kill_all。
//!
//! 通过 `tokio::process::Command` 启动子进程；stdout/stderr 用 `BufReader` 逐行读取，
//! 经 Tauri channel 推送给渲染层；`exited` 通过 exit 事件传递退出码。
//! 每个子进程句柄（含 stdin 写入器）存入共享状态，供 kill / write / list 复用。

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, Stdio};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::Mutex;

use crate::error::CommandError;
use crate::state::AppState;

/// 进程事件（经 channel 推送），对应 TS 的 onStdout / onStderr / onExit。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProcessEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: Option<i32>, signal: Option<String> },
}

/// spawn 返回值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedChild {
    pub id: String,
    pub pid: Option<u32>,
}

/// 进程信息（list 返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfoWire {
    pub id: String,
    pub pid: Option<u32>,
    pub command: String,
    pub args: Vec<String>,
}

/// 运行中的进程句柄。
pub struct RunningProcess {
    pub child: Child,
    pub command: String,
    pub args: Vec<String>,
    pub stdin: Arc<Mutex<Option<ChildStdin>>>,
}

/// 启动子进程。shell=true 时经 `cmd /C` 执行（用于 .bat/.cmd）。
#[tauri::command(rename_all = "snake_case")]
pub async fn process_spawn(
    app: AppHandle,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    shell: Option<bool>,
    channel: Channel<ProcessEvent>,
) -> Result<SpawnedChild, CommandError> {
    let mut cmd = if shell.unwrap_or(false) {
        let mut c = TokioCommand::new("cmd");
        c.arg("/C").arg(&command);
        if !args.is_empty() {
            c.args(&args);
        }
        c
    } else {
        let mut c = TokioCommand::new(&command);
        c.args(&args);
        c
    };
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = env {
        cmd.envs(env);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| CommandError::process_spawn_failed(format!("{command}: {e}")))?;

    let pid = child.id();
    let id = app.state::<AppState>().next_process_id();
    let id_clone = id.clone();
    let command_clone = command.clone();
    let args_clone = args.clone();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    // stdout 行读取 → 推送 Stdout 事件
    if let Some(out) = stdout {
        let ch = channel.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = ch.send(ProcessEvent::Stdout { data: line });
            }
        });
    }
    // stderr 行读取 → 推送 Stderr 事件
    if let Some(err) = stderr {
        let ch = channel.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = ch.send(ProcessEvent::Stderr { data: line });
            }
        });
    }

    let stdin = Arc::new(Mutex::new(stdin));
    let stdin_for_state = stdin.clone();
    let child = RunningProcess {
        child,
        command: command_clone,
        args: args_clone,
        stdin: stdin_for_state,
    };
    app.state::<AppState>()
        .processes
        .lock()
        .await
        .insert(id.clone(), child);

    // 等待退出 → 推送 Exit 事件并从状态移除
    let ch = channel.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit = app2
            .state::<AppState>()
            .processes
            .lock()
            .await
            .get_mut(&id_clone)
            .map(|p| p.child.wait())
            .unwrap_or_else(|| Box::pin(async { Ok(Default::default()) }))
            .await;
        let (code, signal) = match exit {
            Ok(status) => (
                status.code(),
                status
                    .signal()
                    .map(|s| s.to_string()),
            ),
            Err(_) => (None, None),
        };
        let _ = ch.send(ProcessEvent::Exit { code, signal });
        app2
            .state::<AppState>()
            .processes
            .lock()
            .await
            .remove(&id_clone);
    });

    Ok(SpawnedChild { id, pid })
}

/// 向子进程 stdin 写入数据。
#[tauri::command(rename_all = "snake_case")]
pub async fn process_write(
    id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let stdin = {
        let guard = state.processes.lock().await;
        guard
            .get(&id)
            .map(|p| p.stdin.clone())
    };
    match stdin {
        Some(writer) => {
            let mut w = writer.lock().await;
            if let Some(s) = w.as_mut() {
                s.write_all(data.as_bytes())
                    .await
                    .map_err(CommandError::io_error)?;
                s.flush().await.map_err(CommandError::io_error)?;
                Ok(())
            } else {
                Err(CommandError::invalid_argument("该进程 stdin 不可用"))
            }
        }
        None => Err(CommandError::not_found(format!("进程不存在: {id}"))),
    }
}

/// 终止指定子进程。
#[tauri::command(rename_all = "snake_case")]
pub async fn process_kill(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut guard = state.processes.lock().await;
    match guard.get_mut(&id) {
        Some(p) => {
            p.child
                .start_kill()
                .map_err(CommandError::io_error)?;
            Ok(())
        }
        None => Err(CommandError::not_found(format!("进程不存在: {id}"))),
    }
}

/// 列出运行中的进程。
#[tauri::command(rename_all = "snake_case")]
pub async fn process_list(state: State<'_, AppState>) -> Result<Vec<ProcessInfoWire>, CommandError> {
    let guard = state.processes.lock().await;
    let mut out = Vec::new();
    for (id, p) in guard.iter() {
        out.push(ProcessInfoWire {
            id: id.clone(),
            pid: p.child.id(),
            command: p.command.clone(),
            args: p.args.clone(),
        });
    }
    Ok(out)
}

/// 终止全部子进程。
#[tauri::command(rename_all = "snake_case")]
pub async fn process_kill_all(state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut guard = state.processes.lock().await;
    for (_, p) in guard.iter_mut() {
        let _ = p.child.start_kill();
    }
    guard.clear();
    Ok(())
}

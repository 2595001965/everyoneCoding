@echo off
setlocal EnableExtensions EnableDelayedExpansion
title EveryoneCoding 桌面版 - 启动

REM ==========================================================================
REM  EveryoneCoding 桌面版（Electron）启动脚本
REM
REM  执行顺序：
REM    1) 启动渲染层 dev server，监听 http://127.0.0.1:5173
REM    2) 轮询该地址，确认渲染层真的可用
REM    3) 启动 Electron 桌面窗口
REM    4) 自检 electron.exe 进程，确认窗口真的拉起来了
REM
REM  第 3 步调用 apps\desktop-electron\scripts\dev.mjs，它内部完成：
REM    准备原生绑定、esbuild 构建主进程、启动 Electron
REM  不要绕开它直接跑 electron，这条链路已把前置条件都处理好了。
REM
REM  关于 ELECTRON_RUN_AS_NODE：本脚本故意不清除它。dev.mjs 正是靠这个变量识别
REM  "当前运行在嵌入宿主里"，从而启用软件渲染；清除动作由 dev.mjs 在派生 Electron
REM  子进程时自己完成。若在本脚本里提前清掉，等于把 dev.mjs 的判据抹掉。
REM  另外 dev.mjs 自带 GPU 崩溃自动重试，从普通终端启动也能自愈。
REM
REM  两个已知的坑，脚本已规避：
REM    a) 延时用 ping 而非 timeout。timeout 在 stdin 被重定向时报错并空转。
REM    b) 不用 tasklist /V 枚举窗口标题。该调用会触发部分安全策略拦截。
REM
REM  编码约定：本文件为 GBK（cp936）＋ CRLF ＋ 无 BOM。
REM  中文 Windows 下 .bat 若用 UTF-8，cmd.exe 解析多字节字符会错位。
REM  路径全部写死绝对路径，不依赖 PATH 与 pnpm shim，双击即可运行。
REM ==========================================================================

set "REPO=D:\code\program\everyoneCoding"
set "NODE=C:\Users\f2595\AppData\Local\Author Software\nvm\installs\v24.20.0\node.exe"
set "VITE=%REPO%\node_modules\vite\bin\vite.js"
set "RENDERER_DIR=%REPO%\apps\renderer"
set "ELECTRON_DIR=%REPO%\apps\desktop-electron"
set "URL=http://127.0.0.1:5173"
set "T_RENDERER=EC-Renderer"
set "T_ELECTRON=EC-Electron"

set "DELAY_1=ping -n 2 127.0.0.1 >nul 2>&1"
set "DELAY_3=ping -n 4 127.0.0.1 >nul 2>&1"
set "DELAY_4=ping -n 5 127.0.0.1 >nul 2>&1"

echo.
echo  ==================================================
echo   EveryoneCoding 桌面版 启动
echo  ==================================================
echo.

REM ---------------------------------------------------------- 前置条件检查
if not exist "%NODE%" (
  echo [错误] 未找到 Node：
  echo        %NODE%
  echo        请检查 nvm 是否已安装 v24.20.0。
  goto :fail
)
if not exist "%VITE%" (
  echo [错误] 未找到 Vite：
  echo        %VITE%
  echo        请先在仓库根目录执行 pnpm install。
  goto :fail
)
if not exist "%ELECTRON_DIR%\scripts\dev.mjs" (
  echo [错误] 未找到桌面端启动器：
  echo        %ELECTRON_DIR%\scripts\dev.mjs
  goto :fail
)
echo [检查] Node / Vite / 桌面端启动器 均就位

REM ------------------------------------------------------ 1) 启动渲染层
netstat -ano | findstr "LISTENING" | findstr ":5173 " >nul 2>&1
if not errorlevel 1 (
  echo [1/4] 检测到 5173 已在监听，跳过启动，沿用现有服务。
  goto :wait
)
echo [1/4] 启动渲染层 dev server ...
start "%T_RENDERER%" /D "%RENDERER_DIR%" %COMSPEC% /k ""%NODE%" "%VITE%" --host 127.0.0.1 --port 5173"

:wait
REM ------------------------------------------------------ 2) 等渲染层就绪
echo [2/4] 等待 %URL% 可访问 ...
set /a _tries=0
:waitloop
curl -s -f -o nul --max-time 2 "%URL%" >nul 2>&1
if not errorlevel 1 goto :ready
set /a _tries+=1
if !_tries! GEQ 90 (
  echo.
  echo [失败] 已等待约 90 秒，%URL% 仍未就绪。
  echo        请查看 "%T_RENDERER%" 窗口中的报错信息。
  goto :fail
)
%DELAY_1%
goto :waitloop

:ready
echo        OK：%URL% 已就绪

REM ---------------------------------------------------------- 3) Electron
echo [3/4] 启动 Electron 桌面窗口 ...
start "%T_ELECTRON%" /D "%ELECTRON_DIR%" %COMSPEC% /k ""%NODE%" scripts\dev.mjs"

REM ------------------------------------------------ 4) 自检 electron.exe
echo [4/4] 自检 Electron 进程 ...
set "_ec=0"
set /a _etries=0
:ecwait
for /f %%n in ('tasklist /FI "IMAGENAME eq electron.exe" /NH ^| find /c /i "electron.exe"') do set "_ec=%%n"
if !_ec! GTR 0 goto :ecverify
set /a _etries+=1
if !_etries! GEQ 40 (
  echo        [警告] 等待约 60 秒仍未检测到 electron.exe。
  echo               请查看 "%T_ELECTRON%" 窗口中的报错信息。
  goto :ecdone
)
%DELAY_1%
goto :ecwait

:ecverify
REM 计数非 0 后再等 3 秒复查：dev.mjs 的 GPU 兜底重试会先起一批进程再退出，
REM 只看瞬时计数会把它误判成"启动成功"。
%DELAY_3%
set "_ec=0"
for /f %%n in ('tasklist /FI "IMAGENAME eq electron.exe" /NH ^| find /c /i "electron.exe"') do set "_ec=%%n"
if !_ec! GTR 0 goto :ecdone
set /a _etries+=1
%DELAY_1%
goto :ecwait

:ecdone
if !_ec! GTR 0 echo        OK：检测到 !_ec! 个 electron.exe 进程

echo.
echo  ==================================================
echo   启动完成
echo  ==================================================
echo   渲染层窗口：%T_RENDERER%
echo   桌面端窗口：%T_ELECTRON%
echo.
echo   关闭应用请运行：scripts\stop-desktop.bat
echo.
%DELAY_4%
exit /b 0

:fail
echo.
echo  启动失败。
echo.
pause
exit /b 1

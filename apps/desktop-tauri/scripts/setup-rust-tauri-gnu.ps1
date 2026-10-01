<#
  免管理员的 Tauri 构建路径（x86_64-pc-windows-gnu + Zig）

  背景：Tauri 在 Windows 上官方只支持 MSVC 链接器，而 MSVC C++ 生成工具需要管理员
  权限才能安装（见同目录 setup-rust-tauri.ps1）。本脚本提供**非官方支持的替代路径**：
  用 rustup 的 `x86_64-pc-windows-gnu` 工具链（自带 rust-mingw 的 mingw-w64 CRT），
  配合 Zig 提供的 C 编译器 / dlltool / windres，全程装到用户目录。

  它解决四个具体障碍（都是实测踩出来的）：
    1. rust-mingw 只有 CRT 导入库，没有链接器 —— 用 rustc 自带的 `rust-lld` 链接，
       并把 self-contained 目录加进搜索路径；
    2. 没有 C 编译器（ring 等 crate 需要）—— 用 `zig cc`，但必须显式指定
       `-target x86_64-windows-gnu`（Zig 不接受 LLVM 风格的 `x86_64-pc-windows-gnu`），
       并关掉 Zig Debug 模式默认开启的 UBSan（否则测试二进制会差 __ubsan_* 符号）；
    3. rustc 生成 proc-macro 的导入库要调 `dlltool.exe` —— 用 Zig 的 dlltool 顶替；
    4. tauri-build 要调 `windres` 编译资源 —— 用 Zig 的 rc（llvm-rc）顶替，
       并把 windres 风格参数翻译成 rc.exe 风格。

  用法（普通会话即可，不需要管理员）：

      powershell -ExecutionPolicy Bypass -File scripts\setup-rust-tauri-gnu.ps1
      powershell -ExecutionPolicy Bypass -File scripts\setup-rust-tauri-gnu.ps1 -CheckOnly
      powershell -ExecutionPolicy Bypass -File scripts\setup-rust-tauri-gnu.ps1 -RunGates

  已知边界（如实记录，勿据此宣称已验证）：
    * `cargo check` / `cargo clippy` / `cargo build` 与真实启动应用可用（本机实测）；
    * `cargo test --lib` 的测试二进制在本机以 STATUS_ENTRYPOINT_NOT_FOUND(0xC0000139)
      退出 —— 属于该非官方组合的运行期限制，不是仓库代码缺陷。要跑 Rust 单测仍建议
      MSVC 官方工具链（setup-rust-tauri.ps1）。
#>
[CmdletBinding()]
param(
  [string]$ToolchainDir = (Join-Path $env:LOCALAPPDATA 'EveryoneCoding\tauri-gnu'),
  [string]$ZigVersion = '0.16.0',
  [switch]$CheckOnly,
  [switch]$RunGates
)

# 注意：原生程序（cargo / zig / curl）会把进度与警告写到 stderr，
# 在 $ErrorActionPreference='Stop' 下会被当成终止性错误。本脚本改为
# 'Continue'，并逐个检查 $LASTEXITCODE。
$ErrorActionPreference = 'Continue'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    [XX] $msg" -ForegroundColor Red }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$crateDir = Join-Path $repoRoot 'apps\desktop-tauri\src-tauri'
$binDir = Join-Path $ToolchainDir 'bin'
$zigExe = Join-Path $ToolchainDir "zig-x86_64-windows-$ZigVersion\zig.exe"
$rustupHome = Join-Path $env:USERPROFILE '.rustup'
$selfContained = Join-Path $rustupHome "toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained"
$rustLld = Join-Path $rustupHome "toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe"
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

# ------------------------------------------------------------------ 1. 体检

Write-Step '环境体检'
Write-Host "    仓库根      : $repoRoot"
Write-Host "    工具链目录  : $ToolchainDir"

if (-not (Test-Path (Join-Path $cargoBin 'cargo.exe'))) {
  Write-Err2 ' 未找到 rustup 工具链（%USERPROFILE%\.cargo\bin\cargo.exe）。'
  Write-Host '    请先执行：rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-gnu --profile minimal' -ForegroundColor Yellow
  Write-Host '    （下载地址 https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe）' -ForegroundColor Yellow
  exit 1
}
$env:PATH = "$cargoBin;$env:PATH"
Write-Ok "cargo $((& (Join-Path $cargoBin 'cargo.exe') --version 2>&1) -replace 'cargo ','' )"
Write-Host "    rust-lld    : $(if (Test-Path $rustLld) { '已就位' } else { '缺失（需要 stable-x86_64-pc-windows-gnu 工具链）' })"
Write-Host "    mingw CRT   : $(if (Test-Path $selfContained) { '已就位' } else { '缺失' })"
Write-Host "    zig         : $(if (Test-Path $zigExe) { '已就位' } else { '未下载' })"

if ($CheckOnly) {
  Write-Step '仅体检模式，未做任何改动'
  exit 0
}

# ------------------------------------------------------- 2. clippy 组件

Write-Step '确保 clippy 组件就位'
& (Join-Path $cargoBin 'rustup.exe') component add clippy 2>&1 | Out-Null
Write-Ok 'clippy 可用'

# ------------------------------------------------------- 3. Zig 工具链

if (-not (Test-Path $zigExe)) {
  Write-Step "下载并解压 Zig $ZigVersion（约 100MB，来自 ziglang.org）"
  New-Item -ItemType Directory -Force -Path $ToolchainDir | Out-Null
  $zip = Join-Path $ToolchainDir "zig-$ZigVersion.zip"
  $url = "https://ziglang.org/download/$ZigVersion/zig-x86_64-windows-$ZigVersion.zip"
  curl.exe -sS -L --max-time 1800 -o $zip $url
  if ($LASTEXITCODE -ne 0) { Write-Err2 "下载失败：$url"; exit 1 }
  tar.exe -xf $zip -C $ToolchainDir
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path $zigExe)) { Write-Err2 "Zig 不可用：$zigExe"; exit 1 }
Write-Ok "zig $(& $zigExe version)"

# ------------------------------------------------------- 4. 生成 shim

Write-Step "生成工具链 shim（$binDir）"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# zig cc 包装：固定目标三元组、关掉 UBSan、补 self-contained 搜索路径，
# 并丢弃调用方传来的 LLVM 风格 --target（Zig 会以 UnknownOperatingSystem 拒绝）。
$zigccC = @'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ZIG "@ZIG@"
#define SC  "@SC@"
int main(int argc, char **argv) {
    char **out = (char **)malloc(sizeof(char *) * (argc + 8));
    int n = 0;
    out[n++] = ZIG; out[n++] = "cc";
    out[n++] = "-target"; out[n++] = "x86_64-windows-gnu";
    out[n++] = "-fno-sanitize=undefined";
    out[n++] = "-L" SC;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "-target") == 0 || strcmp(a, "--target") == 0) { i++; continue; }
        if (strncmp(a, "-target=", 8) == 0 || strncmp(a, "--target=", 9) == 0) continue;
        out[n++] = argv[i];
    }
    out[n] = NULL;
    /* 不改写首个参数：cmd.exe 对以引号开头的 /c 命令行有特殊解析规则，而 ZIG 路径无空格。 */
    size_t need = 16;
    for (int i = 0; i < n; i++) need += strlen(out[i]) * 2 + 4;
    char *cmd = (char *)malloc(need);
    cmd[0] = '\0';
    for (int i = 0; i < n; i++) {
        if (i) strcat(cmd, " ");
        if (strchr(out[i], ' ') || strchr(out[i], '\t')) { strcat(cmd, "\""); strcat(cmd, out[i]); strcat(cmd, "\""); }
        else strcat(cmd, out[i]);
    }
    int rc = system(cmd);
    free(cmd); free(out);
    return rc;
}
'@

# dlltool 顶替：Zig 自带 llvm-dlltool。
$dlltoolC = @'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ZIG "@ZIG@"
int main(int argc, char **argv) {
    size_t need = strlen(ZIG) + 64;
    for (int i = 1; i < argc; i++) need += strlen(argv[i]) * 2 + 4;
    char *cmd = (char *)malloc(need);
    strcpy(cmd, ZIG); strcat(cmd, " dlltool");
    for (int i = 1; i < argc; i++) {
        if (strchr(argv[i], ' ') || strchr(argv[i], '\t')) { strcat(cmd, " \""); strcat(cmd, argv[i]); strcat(cmd, "\""); }
        else { strcat(cmd, " "); strcat(cmd, argv[i]); }
    }
    int rc = system(cmd);
    free(cmd);
    return rc;
}
'@

# windres 顶替：embed-resource 会以 windres 风格传参，翻译成 rc.exe 风格再交给 zig rc。
$windresC = @'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ZIG "@ZIG@"
#define MAX_ARGS 256
static void add(char **o, int *n, const char *v) { if (*n < MAX_ARGS - 1) o[(*n)++] = (char *)v; }
int main(int argc, char **argv) {
    char *out[MAX_ARGS]; int n = 0; char *input = NULL;
    add(out, &n, ZIG); add(out, &n, "rc");
    add(out, &n, "/:auto-includes"); add(out, &n, "gnu");
    add(out, &n, "/:output-format"); add(out, &n, "coff");
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--input") == 0 && i + 1 < argc) input = argv[++i];
        else if (strcmp(a, "--output") == 0 && i + 1 < argc) { add(out, &n, "/fo"); add(out, &n, argv[++i]); }
        else if (strcmp(a, "--include-dir") == 0 && i + 1 < argc) { add(out, &n, "/i"); add(out, &n, argv[++i]); }
        else if (strncmp(a, "--output-format", 15) == 0) { if (strcmp(a, "--output-format") == 0 && i + 1 < argc) i++; }
        else if (strcmp(a, "--target") == 0 && i + 1 < argc) {
            const char *t = argv[++i];
            const char *m = (strstr(t, "i386") || strstr(t, "i686")) ? "x86" : (strstr(t, "aarch64") ? "aarch64" : "x86_64");
            add(out, &n, "/:target"); add(out, &n, m);
        }
        else if (a[0] == '-' && a[1] == 'D') { add(out, &n, "/d"); add(out, &n, a + 2); }
        else if (a[0] == '-' && a[1] == 'I') { add(out, &n, "/i"); add(out, &n, a + 2); }
        else if (strcmp(a, "-c") == 0 && i + 1 < argc) { add(out, &n, "/c"); add(out, &n, argv[++i]); }
    }
    if (!input) { fprintf(stderr, "windres shim: 缺少 --input\n"); return 1; }
    add(out, &n, input); out[n] = NULL;
    size_t need = 16;
    for (int i = 0; i < n; i++) need += strlen(out[i]) * 4 + 8;
    char *cmd = (char *)malloc(need);
    cmd[0] = '\0';
    for (int i = 0; i < n; i++) {
        if (i) strcat(cmd, " ");
        if (strchr(out[i], ' ') || strchr(out[i], '\t')) { strcat(cmd, "\""); strcat(cmd, out[i]); strcat(cmd, "\""); }
        else strcat(cmd, out[i]);
    }
    int rc = system(cmd);
    free(cmd);
    return rc;
}
'@

# ar 顶替：Zig 自带 ar（0.16 起不再按 argv[0] 分派，必须显式转发子命令）。
$arC = @'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ZIG "@ZIG@"
int main(int argc, char **argv) {
    size_t need = strlen(ZIG) + 64;
    for (int i = 1; i < argc; i++) need += strlen(argv[i]) * 2 + 4;
    char *cmd = (char *)malloc(need);
    strcpy(cmd, ZIG); strcat(cmd, " ar");
    for (int i = 1; i < argc; i++) {
        if (strchr(argv[i], ' ') || strchr(argv[i], '\t')) { strcat(cmd, " \""); strcat(cmd, argv[i]); strcat(cmd, "\""); }
        else { strcat(cmd, " "); strcat(cmd, argv[i]); }
    }
    int rc = system(cmd);
    free(cmd);
    return rc;
}
'@

# C 字符串字面量里的反斜杠必须转义，否则 C:\Users\... 会被当成转义序列。
$zigEsc = $zigExe.Replace('\', '\\')
$scEsc = $selfContained.Replace('\', '\\')
$sources = @{
  'zigcc.c'   = $zigccC.Replace('@ZIG@', $zigEsc).Replace('@SC@', $scEsc)
  'dlltool.c' = $dlltoolC.Replace('@ZIG@', $zigEsc)
  'windres.c' = $windresC.Replace('@ZIG@', $zigEsc)
  'zigar.c'   = $arC.Replace('@ZIG@', $zigEsc)
}
$targets = @{
  'zigcc.c'   = 'zigcc.exe'
  'dlltool.c' = 'dlltool.exe'
  'windres.c' = 'windres.exe'
  'zigar.c'   = 'zigar.exe'
}

foreach ($name in $sources.Keys) {
  $csPath = Join-Path $binDir $name
  [System.IO.File]::WriteAllText($csPath, $sources[$name])
  $exePath = Join-Path $binDir $targets[$name]
  & $zigExe cc -target x86_64-windows-gnu -O2 -o $exePath $csPath
  if ($LASTEXITCODE -ne 0) { Write-Err2 "编译 shim 失败：$name"; exit 1 }
  Write-Ok "$($targets[$name])"
}

# ------------------------------------------------------- 5. 环境变量

Write-Step '环境变量与门禁命令'
$lldPath = $rustLld
Write-Host @"

  新开一个 PowerShell，然后执行：

    `$env:PATH = "$binDir;$cargoBin;`$env:PATH"
    `$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "$lldPath"
    `$env:RUSTFLAGS = "-Clinker-flavor=ld.lld -Clink-arg=-L$selfContained"
    `$env:CC_x86_64_pc_windows_gnu = "$binDir\zigcc.exe"
    `$env:AR_x86_64_pc_windows_gnu = "$binDir\zigar.exe"
    cd "$crateDir"
    cargo check --locked
    cargo clippy --all-targets -- -D warnings
    cargo build --locked

"@ -ForegroundColor Gray

if ($RunGates) {
  Write-Step '运行门禁'
  $env:PATH = "$binDir;$cargoBin;$env:PATH"
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = $lldPath
  $env:RUSTFLAGS = "-Clinker-flavor=ld.lld -Clink-arg=-L$selfContained"
  $env:CC_x86_64_pc_windows_gnu = Join-Path $binDir 'zigcc.exe'
  $env:AR_x86_64_pc_windows_gnu = Join-Path $binDir 'zigar.exe'
  Push-Location $crateDir
  try {
    & cargo check --locked
    Write-Host "cargo check exit=$LASTEXITCODE" -ForegroundColor Cyan
    & cargo clippy --all-targets -- -D warnings
    Write-Host "cargo clippy exit=$LASTEXITCODE" -ForegroundColor Cyan
  } finally {
    Pop-Location
  }
}

Write-Host "`n完成。注意：本路径为**非官方支持**组合；cargo test 的测试二进制在本机无法启动" -ForegroundColor Yellow
Write-Host "（STATUS_ENTRYPOINT_NOT_FOUND）。要跑 Rust 单测请用 setup-rust-tauri.ps1 装 MSVC。" -ForegroundColor Yellow

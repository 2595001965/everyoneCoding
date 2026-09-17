#Requires -RunAsAdministrator
<#
  灰白云 / EveryoneCoding —— Tauri 形态前置条件一键安装

  为什么必须管理员：Tauri 在 Windows 上唯一官方支持的链接器来自 MSVC
  （Visual Studio Build Tools 的 link.exe）。它按机器级安装、需要写入
  Program Files 与注册表，无法在普通用户下完成。Rust 工具链本身可以装到
  用户目录，但没有 link.exe 时连 `cargo check` 都跑不起来（build script 与
  proc-macro 都需要链接），所以两者必须一起装。

  用法（右键「以管理员身份运行 PowerShell」，然后执行）：
      powershell -ExecutionPolicy Bypass -File scripts\setup-rust-tauri.ps1

  可选参数：
      -SkipBuildTools   仅装 Rust 工具链（例如你已有 VS/VS Build Tools）
      -NoMirror         不写入国内镜像配置（默认写入，加速 crates 拉取）
      -CheckOnly        只做环境体检，不安装任何东西
#>
[CmdletBinding()]
param(
  [switch]$SkipBuildTools,
  [switch]$NoMirror,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    [XX] $msg" -ForegroundColor Red }

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- 1. 环境体检

Write-Step '环境体检'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Write-Ok '当前为管理员会话' } else { Write-Err2 '当前不是管理员会话（脚本无法继续）'; exit 1 }

if (Test-Command 'winget') { Write-Ok 'winget 可用' } else { Write-Err2 'winget 不可用，请先安装「应用安装程序」'; exit 1 }

Write-Host "    rustup : $(if (Test-Command 'rustup') { (rustup --version 2>&1) -join '' } else { '未安装' })"
Write-Host "    cargo  : $(if (Test-Command 'cargo') { (cargo --version 2>&1) -join '' } else { '未安装' })"

# vswhere 是 VS 安装器的定位工具，随任何 VS/Build Tools 安装存在
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasMsvc = Test-Path $vswhere
if ($hasMsvc) {
  $vcTools = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  $hasMsvc = [bool]$vcTools
}
if ($hasMsvc) { Write-Ok 'MSVC C++ 生成工具已就绪' } else { Write-Warn2 'MSVC C++ 生成工具缺失（Tauri 编译必需）' }

if ($CheckOnly) {
  Write-Step '仅体检模式，未做任何改动'
  exit 0
}

# ------------------------------------------------------- 2. MSVC 生成工具

if (-not $SkipBuildTools) {
  if ($hasMsvc) {
    Write-Step 'MSVC C++ 生成工具已存在，跳过安装'
  } else {
    Write-Step '安装 Visual Studio 2022 Build Tools（含 VCTools 工作负载，约 3-6 GB，耗时较长）'
    $override = '--quiet --wait --norestart --nocache ' +
                '--add Microsoft.VisualStudio.Workload.VCTools ' +
                '--includeRecommended'
    & winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --override $override
    if ($LASTEXITCODE -ne 0) {
      Write-Err2 "Build Tools 安装返回码 $LASTEXITCODE。可改用图形界面安装并勾选「使用 C++ 的桌面开发」。"
    } else {
      Write-Ok 'Build Tools 安装完成'
    }
  }
} else {
  Write-Step '按要求跳过 MSVC 生成工具安装'
}

# ------------------------------------------------------------ 3. Rust 工具链

if (Test-Command 'rustup') {
  Write-Step 'Rust 工具链已存在，跳过安装'
} else {
  Write-Step '安装 Rust 工具链（rustup + stable，用户级安装）'
  $env:RUSTUP_DIST_SERVER = 'https://mirrors.tuna.tsinghua.edu.cn/rustup'
  $env:RUSTUP_UPDATE_ROOT = 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup'

  if (Test-Command 'winget') {
    & winget install --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
  }
  if (-not (Test-Command 'rustup')) {
    Write-Warn2 'winget 安装未生效，回退为直接下载 rustup-init.exe'
    $init = Join-Path $env:TEMP 'rustup-init.exe'
    Invoke-WebRequest -Uri "$env:RUSTUP_UPDATE_ROOT/dist/x86_64-pc-windows-msvc/rustup-init.exe" -OutFile $init -UseBasicParsing
    & $init -y --default-toolchain stable --default-host x86_64-pc-windows-msvc --profile minimal
  }
  Write-Ok 'Rust 工具链安装完成（新开终端后 PATH 才会生效）'
}

# ---------------------------------------------------------- 4. 国内镜像配置

if (-not $NoMirror) {
  Write-Step '写入 cargo 国内镜像配置（加速 crates 拉取）'
  $cargoDir = Join-Path $env:USERPROFILE '.cargo'
  $cargoConfig = Join-Path $cargoDir 'config.toml'
  New-Item -ItemType Directory -Force -Path $cargoDir | Out-Null
  if (Test-Path $cargoConfig) {
    $stamp = Join-Path $cargoDir "config.toml.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $cargoConfig $stamp
    Write-Ok "已备份原配置到 $stamp"
  }
  @'
# 由 apps/desktop-tauri/scripts/setup-rust-tauri.ps1 生成
[source.crates-io]
replace-with = 'tuna'

[source.tuna]
registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"

[net]
git-fetch-with-cli = true
'@ | Set-Content -Path $cargoConfig -Encoding UTF8
  Write-Ok "已写入 $cargoConfig"
}

# ------------------------------------------------------------ 5. 最终验证

Write-Step '最终验证'
Write-Warn2 '注意：若刚装完 Rust，当前会话的 PATH 可能尚未刷新，请新开一个终端后再跑下面的命令。'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
Write-Host "`n请在新终端中依次执行：`n" -ForegroundColor Cyan
Write-Host "  cd `"$repoRoot\apps\desktop-tauri\src-tauri`""
Write-Host "  cargo check            # 首次会拉取并编译依赖，耗时较长"
Write-Host "  cargo clippy --all-targets -- -D warnings   # 质量门禁要求的零 warning"
Write-Host "  cd `"$repoRoot`""
Write-Host "  pnpm build:tauri       # 产出 NSIS 安装包`n"
Write-Host '完成后即可补齐验收报告中 L-09 一项。' -ForegroundColor Green

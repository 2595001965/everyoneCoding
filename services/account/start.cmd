@echo off
REM 一键启动脚本（Windows）
REM 1) 安装依赖（腾讯镜像） 2) 启动账号服务端
setlocal
cd /d "%~dp0\..\.."

set NODE24="C:\Users\f2595\AppData\Local\Author Software\nvm\installs\v24.20.0\node.exe"
set PNPM=%NODE24% "C:\Users\f2595\AppData\Local\node\corepack\v1\pnpm\9.15.9\bin\pnpm.cjs"

echo ==^> 安装依赖
%NODE24% %PNPM% install --registry=https://mirrors.cloud.tencent.com/npm/
if errorlevel 1 (
  echo pnpm 安装失败，请确认 Node 24 与 corepack 可用
  exit /b 1
)

echo ==^> 启动账号服务端（services/account）
%NODE24% services/account/src/server.ts
endlocal

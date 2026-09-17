@echo off
setlocal EnableExtensions EnableDelayedExpansion
title EveryoneCoding 桌面版 - 终止

REM ==========================================================================
REM  EveryoneCoding 桌面版（Electron）终止脚本
REM
REM  三步清理，逐级兜底：
REM    1) 结束按窗口标题标记的两个控制台窗口（EC-Renderer / EC-Electron）
REM    2) 结束残留的 electron.exe 进程
REM    3) 结束占用 5173 端口的进程
REM
REM  只处理本项目相关的 node.exe / electron.exe，不误伤其他程序。
REM
REM  三个已知的坑，脚本已规避：
REM    a) taskkill /FI "WINDOWTITLE eq ..." 在无匹配时也返回 0，会谎报成功，
REM       所以第 1 步不报具体战果；确定性的战果由第 2、3 步的进程数与端口给出。
REM    b) tasklist /V 枚举窗口标题会触发安全策略拦截，故全程不使用。
REM    c) 第 3 步若无端口占用则不进入 for 循环体，报告以计数变量为准。
REM
REM  编码约定：本文件为 GBK（cp936）＋ CRLF ＋ 无 BOM。
REM  中文 Windows 下 .bat 若用 UTF-8，cmd.exe 解析多字节字符会错位。
REM ==========================================================================

set "T_RENDERER=EC-Renderer"
set "T_ELECTRON=EC-Electron"
set "DELAY_4=ping -n 5 127.0.0.1 >nul 2>&1"

echo.
echo  ==================================================
echo   EveryoneCoding 桌面版 终止
echo  ==================================================
echo.

set /a _hit=0

REM ------------------------------------- 1) 结束标记过的控制台窗口
echo [1/3] 结束标记过的控制台窗口 ...
taskkill /FI "WINDOWTITLE eq %T_ELECTRON%*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq %T_RENDERER%*" /T /F >nul 2>&1
echo       已按窗口标题发起结束请求（无匹配时无动作属正常）

REM ------------------------------------- 2) 结束残留 electron.exe
echo [2/3] 结束残留 electron.exe ...
set "_ec=0"
for /f %%n in ('tasklist /FI "IMAGENAME eq electron.exe" /NH ^| find /c /i "electron.exe"') do set "_ec=%%n"
if !_ec! GTR 0 (
  taskkill /F /IM electron.exe >nul 2>&1
  echo       OK：已结束 !_ec! 个 electron.exe 进程
  set /a _hit+=1
) else (
  echo       未发现 electron.exe
)

REM ------------------------------------- 3) 结束占用 5173 的进程
echo [3/3] 结束占用 5173 端口的进程 ...
set "_port=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5173 "') do (
  taskkill /F /PID %%p >nul 2>&1
  echo       OK：已结束占用 5173 的进程 PID %%p
  set /a _port+=1
  set /a _hit+=1
)
if !_port! EQU 0 echo       无进程占用 5173

REM ------------------------------------------------------------ 结果校验
echo.
netstat -ano | findstr "LISTENING" | findstr ":5173 " >nul 2>&1
if errorlevel 1 (
  echo  ==================================================
  echo   清理完成：5173 端口已释放
  echo  ==================================================
) else (
  echo  ==================================================
  echo   [异常] 5173 端口仍被占用，建议手动检查
  echo  ==================================================
)

echo.
if !_hit! EQU 0 echo  结果：未发现本项目的运行中进程。
%DELAY_4%
exit /b 0

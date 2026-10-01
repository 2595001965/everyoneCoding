; Electron NSIS 安装钩子（T10-04 / FR-SET-05），与 Tauri 版 `nsis/installer-hooks.nsh` 同口径。
;
; 装完本版本后把自身安装包以**规范文件名**留档，供下一版本启动失败时静默重装回退：
;   %LOCALAPPDATA%\EveryoneCoding-updates\electron\EveryoneCoding-<版本>-x64-setup.exe
; （两种形态分目录留档，见 Tauri 版钩子的说明）
;
; 经 electron-updater 安装时 $EXEPATH 位于 `%LOCALAPPDATA%\@ecdesktop-electron-updater\pending\`，
; 文件名虽带版本号，但仍统一改写为规范名 —— 客户端（update-shell-ports.ts）只按版本号匹配，
; 不依赖安装来源。卸载时保留留档（用户重装旧版本仍可回退）。

!macro customInstall
  DetailPrint "EveryoneCoding: 留档本版本安装包（供更新失败回滚）"
  CreateDirectory "$LOCALAPPDATA\EveryoneCoding-updates\electron"
  CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\EveryoneCoding-updates\electron\EveryoneCoding-${VERSION}-x64-setup.exe"
!macroend

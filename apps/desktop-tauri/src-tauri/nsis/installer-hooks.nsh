; Tauri 2 NSIS 安装钩子（T10-04 / FR-SET-05）。
;
; 目的：让"更新失败可回滚到上一版本"有可还原的东西。
; NSIS 安装器在**装完本版本后**把自身安装包留档一份到固定目录，
; 于是"当前已安装版本"的安装包始终可在此找到 —— 下一版本启动崩溃时，
; 客户端（@ec/core 的 UpdateService）直接静默重跑这份安装包即可回退。
;
; 目录约定（与 `update-shell-ports.ts` 的 defaultBackupDir 保持一致）：
;   %LOCALAPPDATA%\EveryoneCoding\updates\backup\<安装包文件名>
; 安装包文件名自带版本号（EveryoneCoding_0.1.0_x64-setup.exe），
; 客户端按版本号匹配文件即可，无需额外元数据。
;
; 注意：用户若把数据目录迁到别处（FR-SET-03），此固定目录仍在 LocalAppData；
; 客户端找不到对应版本的留档时会如实上报"无备份，无法自动回滚"，不会假装成功。

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "EveryoneCoding: 留档本版本安装包（供更新失败回滚）"
  CreateDirectory "$LOCALAPPDATA\EveryoneCoding\updates\backup"
  CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\EveryoneCoding\updates\backup\"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载时保留留档：用户重装旧版本仍可回退。仅在用户显式清数据时人工删除。
!macroend

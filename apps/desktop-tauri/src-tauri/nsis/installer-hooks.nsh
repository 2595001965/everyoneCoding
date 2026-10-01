; Tauri 2 NSIS 安装钩子（T10-04 / FR-SET-05）。
;
; 目的：让"更新失败可回滚到上一版本"有可还原的东西。
; NSIS 安装器在**装完本版本后**把自身安装包留档一份到固定目录，
; 于是"当前已安装版本"的安装包始终可在此找到 —— 下一版本启动崩溃时，
; 客户端（@ec/core 的 UpdateService）直接静默重跑这份安装包即可回退。
;
; 目录约定（与 `app_info_get` 返回的 updateBackupDir、`update-shell-ports.ts` 一致）：
;   %LOCALAPPDATA%\EveryoneCoding-updates\tauri\EveryoneCoding_<版本>_x64-setup.exe
;
; 为什么不放在 %LOCALAPPDATA%\EveryoneCoding 下：那正是 Tauri 当前用户安装的默认安装目录，
; 留档会被当成安装目录的一部分；两种形态也必须**分目录**留档，否则按版本号匹配时会拿错形态的安装包。
;
; **必须用规范文件名另存，不能沿用 $EXEPATH 的原名**：经 Tauri updater 安装时，
; 安装包在插件建的随机临时目录里、名字也与发布名不同（`EveryoneCoding-<v>-installer.exe`），
; 按发布名匹配不到 —— 回滚会被误判为"没有备份"。
;
; 注意：用户若把数据目录迁到别处（FR-SET-03），此固定目录仍在 LocalAppData；
; 客户端找不到对应版本的留档时会如实上报"无备份，无法自动回滚"，不会假装成功。

; 覆盖文件前先等旧进程**彻底**放手主程序文件（最多 30 秒）。
;
; 真实安装包演练实测：Tauri updater 拉起安装器后应用进程在 ~0.5s 内消失，但主程序 exe
; 仍被系统锁住约 5 秒（WebView2 收尾）；被动模式（/P）的安装器恰好在这段时间写文件，
; 弹出"无法打开要写入的文件"的 中止/重试/忽略 对话框并一直停在那里 —— 用户看到的是
; "更新到一半卡住"。回滚时静默重跑留档安装包也是同一时序，同样需要这段等待。
!macro NSIS_HOOK_PREINSTALL
  Push $R8
  Push $R9
  StrCpy $R9 0
  ec_wait_exe:
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 ec_wait_done
    ClearErrors
    FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors 0 ec_wait_writable
    IntOp $R9 $R9 + 1
    IntCmp $R9 60 ec_wait_done
    Sleep 500
    Goto ec_wait_exe
  ec_wait_writable:
    FileClose $R8
  ec_wait_done:
  Pop $R9
  Pop $R8
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "EveryoneCoding: 留档本版本安装包（供更新失败回滚）"
  CreateDirectory "$LOCALAPPDATA\EveryoneCoding-updates\tauri"
  CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\EveryoneCoding-updates\tauri\EveryoneCoding_${VERSION}_x64-setup.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载时保留留档：用户重装旧版本仍可回退。仅在用户显式清数据时人工删除。
!macroend

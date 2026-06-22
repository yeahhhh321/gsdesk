!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  RMDir /r "$APPDATA\com.core.gsdesk"
  RMDir /r "$LOCALAPPDATA\com.core.gsdesk"
  RMDir /r "$APPDATA\GSDesk"
  RMDir /r "$LOCALAPPDATA\GSDesk"
!macroend

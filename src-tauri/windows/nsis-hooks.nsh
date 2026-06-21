!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  RMDir /r "$APPDATA\com.yeahhhh321.gsdesk"
  RMDir /r "$LOCALAPPDATA\com.yeahhhh321.gsdesk"
  RMDir /r "$APPDATA\GSDesk"
  RMDir /r "$LOCALAPPDATA\GSDesk"
!macroend

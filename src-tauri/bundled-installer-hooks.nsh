!define DSH_MAX_INSTALL_DIR_LENGTH 71

!macro NSIS_HOOK_PREINSTALL
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${DSH_MAX_INSTALL_DIR_LENGTH}
    MessageBox MB_OK|MB_ICONSTOP \
      "The selected installation folder is too long. Choose a folder with at most ${DSH_MAX_INSTALL_DIR_LENGTH} characters.$\r$\n所选安装目录过长，请选择不超过 ${DSH_MAX_INSTALL_DIR_LENGTH} 个字符的目录。" \
      /SD IDOK
    Abort
  ${EndIf}
!macroend

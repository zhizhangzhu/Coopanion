; app/terminal.cjs keeps credentials and settings outside the installation directory.
!macro customFiles_x64
  ${IfNot} ${FileExists} "$INSTDIR\AstrBot Desktop Pet.exe"
  ${OrIfNot} ${FileExists} "$INSTDIR\resources\app\core\astrbot\native.ts"
  ${OrIfNot} ${FileExists} "$INSTDIR\resources\app\core\astrbot\native-bridge.ts"
  ${OrIfNot} ${FileExists} "$INSTDIR\resources\app\node_modules\tsx\dist\loader.mjs"
    MessageBox MB_OK|MB_ICONSTOP "$(decompressionFailed)" /SD IDOK
    Abort
  ${EndIf}
!macroend

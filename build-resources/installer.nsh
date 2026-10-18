; Jiyu custom NSIS hooks (wired via build.nsis.include in package.json).
;
; Builds up to 0.3.77 shipped Capacitor's Android Gradle output inside
; resources\app.asar.unpacked\node_modules\@capacitor (paths over 240 chars).
; During an update the OLD uninstaller moves every installed file into
; %TEMP%\nsXXXX.tmp\old-install with MAX_PATH-limited Rename. Those long paths
; fail, the uninstaller aborts, and the new installer then shows
; "Jiyu cannot be closed. Please close it manually and click Retry" forever.
;
; customInit runs from .onInit (outer and elevated inner instance), which is
; before the install section calls uninstallOldVersion. The Electron app never
; uses that folder, so removing it is safe. On a fresh install there is no
; InstallLocation in the registry and this does nothing.

!macro jiyuPurgeLegacyCapacitor ROOT_KEY
  ClearErrors
  ReadRegStr $R9 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R9 != ""
    StrCpy $R8 "$R9\resources\app.asar.unpacked\node_modules\@capacitor"
    ${If} ${FileExists} "$R8\*.*"
      DetailPrint `Removing legacy Android build files from "$R8"`
      RMDir /r "$R8"
      ; RMDir cannot see paths past MAX_PATH; retry with the \\?\ prefix.
      ${If} ${FileExists} "$R8\*.*"
        nsExec::Exec `"$SYSDIR\cmd.exe" /C rd /s /q "\\?\$R8"`
        Pop $R7
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro customInit
  Push $R7
  Push $R8
  Push $R9
  ; Per-machine install (C:\Program Files\Jiyu) needs admin rights to modify,
  ; so only the elevated instance touches it.
  ${If} ${UAC_IsAdmin}
    !insertmacro jiyuPurgeLegacyCapacitor HKEY_LOCAL_MACHINE
  ${EndIf}
  ; Per-user install (%LOCALAPPDATA%\Programs\Jiyu) is writable without admin.
  !insertmacro jiyuPurgeLegacyCapacitor HKEY_CURRENT_USER
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

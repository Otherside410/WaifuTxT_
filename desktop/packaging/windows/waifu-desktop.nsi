; Installateur NSIS de WaifuChat natif (Rust/GPUI) — W07. NON COMPILÉ ni exécuté sur la VM de développement
; (aucune chaîne Windows) : à valider au premier run du job `windows` de desktop-rust.yml.
;
; Compilation : makensis /DVERSION=0.1.0 /DEXE=..\..\target\release\waifu-desktop.exe waifu-desktop.nsi
;
; Cohabitation avec l'app Electron pendant le chantier (décision d'Otherside) : nom, dossier d'installation, clé de
; désinstallation et AppUserModelID DISTINCTS de ceux d'Electron ; données dans %APPDATA%\waifu-desktop-rust (jamais celles
; d'Electron). La bascule vers l'appId historique ne se fait qu'à la mise en production validée.

!ifndef VERSION
  !error "définir /DVERSION=X.Y.Z"
!endif
!ifndef EXE
  !error "définir /DEXE=chemin\vers\waifu-desktop.exe"
!endif

!define APPNAME "WaifuChat Native"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WaifuChatNative"

Name "${APPNAME}"
OutFile "WaifuChat-${VERSION}-x64-setup.exe"
Unicode true
; Installation par utilisateur : pas de droits administrateur (cohérent avec une mise à jour qui remplace le fichier).
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "/oname=waifu-desktop.exe" "${EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\waifu-desktop.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Les données de l'utilisateur (%APPDATA%\waifu-desktop-rust) ne sont jamais supprimées ici.
  Delete "$INSTDIR\waifu-desktop.exe"
  Delete "$INSTDIR\waifu-desktop.exe.previous"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd

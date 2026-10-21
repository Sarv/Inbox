; Register Sarv Inbox as a candidate for Windows Default Apps. The app opens
; Settings only after the user asks; installation never chooses a default.
; Do not use electron-builder's APP_ASSOCIATE: it replaces .ics's unnamed value.
!include "LogicLib.nsh"

!define SARV_DEFAULT_APP_ID "com.sarv.sarvinbox"
!define SARV_DEFAULT_APP_CLIENT "Software\Clients\Mail\Sarv Inbox"
!define SARV_DEFAULT_APP_CAPABILITIES "${SARV_DEFAULT_APP_CLIENT}\Capabilities"

!macro sarvRegisterDefaultAppProgId SUFFIX DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.${SUFFIX}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.${SUFFIX}" "FriendlyTypeName" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.${SUFFIX}\DefaultIcon" "" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.${SUFFIX}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customInstall
  ; $appExe is initialized by electron-builder 26's installSection.nsh.
  !insertmacro sarvRegisterDefaultAppProgId "ics" "iCalendar calendar"
  !insertmacro sarvRegisterDefaultAppProgId "mailto" "URL:Mail message"
  !insertmacro sarvRegisterDefaultAppProgId "webcal" "URL:Calendar subscription"
  !insertmacro sarvRegisterDefaultAppProgId "webcals" "URL:Secure calendar subscription"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.mailto" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.webcal" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.webcals" "URL Protocol" ""
  WriteRegNone SHELL_CONTEXT "Software\Classes\.ics\OpenWithProgids" "${SARV_DEFAULT_APP_ID}.ics"

  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CLIENT}" "" "Sarv Inbox"
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}" "ApplicationName" "Sarv Inbox"
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}" "ApplicationDescription" "Email and local calendars in Sarv Inbox"
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}" "ApplicationIcon" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}\FileAssociations" ".ics" "${SARV_DEFAULT_APP_ID}.ics"
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}\UrlAssociations" "mailto" "${SARV_DEFAULT_APP_ID}.mailto"
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}\UrlAssociations" "webcal" "${SARV_DEFAULT_APP_ID}.webcal"
  WriteRegStr SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}\UrlAssociations" "webcals" "${SARV_DEFAULT_APP_ID}.webcals"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Sarv Inbox" "${SARV_DEFAULT_APP_CAPABILITIES}"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro sarvUnregisterDefaultAppProgId SUFFIX
  ; Keep a registration that a different installation now owns. $appExe is
  ; installer-only: BUILD_UNINSTALLER uses the installed path instead.
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.${SUFFIX}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${SARV_DEFAULT_APP_ID}.${SUFFIX}"
    !if "${SUFFIX}" == "ics"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.ics\OpenWithProgids" "${SARV_DEFAULT_APP_ID}.ics"
      DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.ics\OpenWithProgids"
    !endif
  ${EndIf}
!macroend

!macro customUnInstall
  ; Upgrades refresh the same registrations. Never touch UserChoice, another
  ; app's ProgID, or an extension/protocol's selected default on either path.
  ${IfNot} ${isUpdated}
    Push $R0
    !insertmacro sarvUnregisterDefaultAppProgId "ics"
    !insertmacro sarvUnregisterDefaultAppProgId "mailto"
    !insertmacro sarvUnregisterDefaultAppProgId "webcal"
    !insertmacro sarvUnregisterDefaultAppProgId "webcals"
    ReadRegStr $R0 SHELL_CONTEXT "${SARV_DEFAULT_APP_CAPABILITIES}" "ApplicationIcon"
    ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
      DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Sarv Inbox"
      DeleteRegKey SHELL_CONTEXT "${SARV_DEFAULT_APP_CLIENT}"
    ${EndIf}
    Pop $R0
    System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
  ${EndIf}
!macroend

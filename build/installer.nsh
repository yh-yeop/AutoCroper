; AutoCroper NSIS 추가 스크립트 (package.json build.nsis.include)
;
; 이미지 확장자를 '연결 프로그램(Open with)' 목록에만 등록한다.
; electron-builder의 fileAssociations는 Software\Classes\.jpg 의 기본값까지 덮어써서
; 기본 사진 뷰어를 가로챌 수 있고, 제거할 때 그 기본값을 되돌리지도 않는다.
; 그래서 여기서는 .ext 의 기본값은 건드리지 않고 OpenWithProgids / SupportedTypes 와
; '기본 앱' 설정용 Capabilities 만 쓴다. 기본 앱으로 쓸지는 사용자가 Windows 설정에서 고른다.

!define AC_PROGID "AutoCroper.Image"
!define AC_APPKEY "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!define AC_CAPKEY "Software\AutoCroper\Capabilities"

!macro acRegisterExt EXT
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${AC_PROGID}"
  WriteRegStr SHELL_CONTEXT "${AC_APPKEY}\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHELL_CONTEXT "${AC_CAPKEY}\FileAssociations" ".${EXT}" "${AC_PROGID}"
!macroend

!macro acUnregisterExt EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${AC_PROGID}"
!macroend

!macro customInstall
  ; ProgID: 탐색기에 보이는 이름과 열기 명령
  WriteRegStr SHELL_CONTEXT "Software\Classes\${AC_PROGID}" "" "AutoCroper 이미지"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${AC_PROGID}" "FriendlyTypeName" "AutoCroper 이미지"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${AC_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${AC_PROGID}\shell\open" "" "AutoCroper로 흰 여백 자르기"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${AC_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; 'Applications' 항목: 연결 프로그램 목록에 표시될 이름
  WriteRegStr SHELL_CONTEXT "${AC_APPKEY}" "FriendlyAppName" "AutoCroper"
  WriteRegStr SHELL_CONTEXT "${AC_APPKEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${AC_APPKEY}\shell\open" "" "AutoCroper로 흰 여백 자르기"
  WriteRegStr SHELL_CONTEXT "${AC_APPKEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Windows 설정 > 기본 앱 에서 고를 수 있게 (기본값으로 지정하지는 않음)
  WriteRegStr SHELL_CONTEXT "${AC_CAPKEY}" "ApplicationName" "AutoCroper"
  WriteRegStr SHELL_CONTEXT "${AC_CAPKEY}" "ApplicationDescription" "흰 배경 사진 · 스캔본의 흰 여백을 자동으로 잘라 냅니다."
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "AutoCroper" "${AC_CAPKEY}"

  !insertmacro acRegisterExt "jpg"
  !insertmacro acRegisterExt "jpeg"
  !insertmacro acRegisterExt "png"
  !insertmacro acRegisterExt "webp"
  !insertmacro acRegisterExt "bmp"
  !insertmacro acRegisterExt "gif"

  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend

!macro customUnInstall
  !insertmacro acUnregisterExt "jpg"
  !insertmacro acUnregisterExt "jpeg"
  !insertmacro acUnregisterExt "png"
  !insertmacro acUnregisterExt "webp"
  !insertmacro acUnregisterExt "bmp"
  !insertmacro acUnregisterExt "gif"

  DeleteRegKey SHELL_CONTEXT "Software\Classes\${AC_PROGID}"
  DeleteRegKey SHELL_CONTEXT "${AC_APPKEY}"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "AutoCroper"
  DeleteRegKey SHELL_CONTEXT "Software\AutoCroper"

  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend

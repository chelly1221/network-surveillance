# PingTester - Electron 기반 네트워크 감시 프로그램

## 프로젝트 개요
김포공항 레이더/관제송신소 네트워크 감시 프로그램.
최대 20개 대상에 대한 ICMP ping 모니터링, 장애 로깅, UDP 알림, 경보음 재생 기능.

## 기술 스택
- **Runtime**: Electron (Node.js)
- **UI**: HTML + CSS (순수 웹 기술, 프레임워크 없음)
- **2D 시각화**: Canvas 2D (renderer/view2d.js)
- **Language**: JavaScript (ES Modules in renderer, CommonJS in main)
- **Build**: electron-builder (Windows portable .exe)
- **Platform**: Windows only

## 프로젝트 구조
```
pingtester/
├── CLAUDE.md
├── README.md
├── package.json
├── main.js              # Electron 메인 프로세스 (ping, UDP, sound, settings, packet capture)
├── preload.js           # contextBridge API (main↔renderer IPC, EVENT_CHANNELS 기반)
├── renderer/
│   ├── index.html       # 메인 UI (테이블 + 2D 토폴로지 뷰, ARIA 접근성 적용)
│   ├── renderer.js      # UI 로직 및 IPC 호출
│   ├── styles.css       # 스타일시트 (WCAG AA 대비 준수)
│   ├── view2d.js        # Canvas 2D 토폴로지 시각화 + 미등록 노드
│   └── topoEditor.js    # 캔버스 기반 토폴로지 편집기
├── assets/
│   ├── icon.ico         # 앱 아이콘
│   ├── app_icon.png     # 앱 아이콘 (PNG)
│   └── failed.wav       # 경보음 파일
└── settings.json        # 사용자 설정 (런타임 생성, .gitignore에 포함)
```

## 아키텍처 원칙
- **Main process**: ping 실행, UDP 소켓, 파일 I/O, 사운드 재생, 패킷 캡처 등 시스템 작업 담당
- **Renderer process**: UI 렌더링만 담당, contextBridge를 통해 main과 통신
- **IPC 통신**: preload.js의 contextBridge로 안전하게 API 노출
  - `on*` 함수는 unsubscribe 핸들을 반환
  - `EVENT_CHANNELS` 상수로 이벤트 채널 관리
- **설정 파일**: exe와 같은 디렉토리의 settings.json (portable 호환)
  - 저장은 tmp+rename 패턴으로 atomic write
  - `saveSettings()`는 성공/실패 boolean 반환
  - 실패 시 in-memory 상태 rollback

## 빌드 및 실행
```bash
npm install              # 의존성 설치 (postinstall에서 네이티브 모듈 자동 rebuild)
npm start                # 개발 모드 실행
npm run build            # Windows portable exe 빌드 (dist/PingTester-{version}.exe)
```

### WSL2 환경에서 빌드
WSL2에서는 wine이 없어 직접 `npm run build`가 실패하므로 `cmd.exe`를 경유하여 Windows 네이티브로 빌드:
```bash
cmd.exe /c "cd /d C:\code\pingtester && npm run build"
```

## 보안 원칙
- **프로토타입 오염 방어**: `sanitizeObject()` 재귀 함수로 `__proto__`, `constructor`, `prototype` 키 제거
- **설정 키 허용 목록**: `ALLOWED_SETTINGS_KEYS` Set으로 허용된 키만 저장/로드
- **서버사이드 입력 검증**: 주소(253자, regex), IP(옥텟 0-255), 포트(1-65535), 메시지(1024자), 이름(100자), 토폴로지(장비 100개, 연결 500개)
- **XSS 방어**: `escapeHtml()` (& < > " '), `escapeAttr()` 적용
- **CSP**: Content Security Policy로 스크립트/스타일 소스 제한
- **사운드 파일**: 확장자 검증 (.wav, .mp3, .ogg만 허용)

## 코딩 컨벤션
- UI 텍스트는 한국어
- 변수/함수명은 영어 camelCase
- 설정 JSON 키는 snake_case (기존 호환)
- 에러 처리: 사용자에게 영향 없이 콘솔 로깅, IPC 반환값으로 실패 전달
- ping은 Windows `ping -n 1` 명령 사용
- 주소 검증: `/^[a-zA-Z0-9]+([.\-][a-zA-Z0-9]+)*$/` (main + renderer 양쪽)
- HTML: 모든 button에 `type="button"`, 모달에 ARIA role/aria-labelledby, SVG에 `aria-hidden`
- CSS: WCAG AA 대비 준수, `:focus-visible` 스타일 적용
- Canvas: DPR(devicePixelRatio) 보정, `canvas._logicalW`/`_logicalH`로 논리 크기 관리
- Canvas 렌더: `requestAnimationFrame` 배칭 (`scheduleRender()` 패턴)

## 주요 기능
1. **감시 대상 관리**: 최대 20개, 활성화/비활성화 가능, 중복 IP 경고
2. **실시간 ping**: 설정 주기(초)마다 각 대상 ping, 모든 타겟 첫 응답 후 알람 평가
3. **상태 표시**: 성공(흰색), 장애(빨간색), 비활성화(회색)
4. **장애 로그**: 최근 100건 표시, 상태 전환 시에만 기록
5. **UDP 알림**: 장애/정상 시 설정된 주소로 UDP 메시지 전송
6. **경보음**: 장애 감지 시 WAV 파일 재생 (음소거 가능)
7. **설정 저장**: JSON 파일로 영속 저장 (저장 실패 시 rollback)
8. **2D 토폴로지 뷰**: Canvas 2D 토폴로지 + 미등록 노드 목록, 실시간 상태 시각화
9. **물리 토폴로지 편집**: 캔버스 기반 장비 배치 및 연결 편집
10. **패킷 캡처**: Npcap 기반 IPv4 트래픽 모니터링, 다중 어댑터 동시 캡처, ASTERIX 프로토콜 감지

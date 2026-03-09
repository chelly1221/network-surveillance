# PingTester - Electron 기반 네트워크 감시 프로그램

## 프로젝트 개요
김포공항 레이더/관제송신소 네트워크 감시 프로그램.
최대 20개 대상에 대한 ICMP ping 모니터링, 장애 로깅, UDP 알림, 경보음 재생 기능.

## 기술 스택
- **Runtime**: Electron (Node.js)
- **UI**: HTML + CSS (순수 웹 기술, 프레임워크 없음)
- **Language**: JavaScript (ES Modules in renderer, CommonJS in main)
- **Build**: electron-builder (Windows portable .exe)
- **Platform**: Windows only

## 프로젝트 구조
```
pingtester/
├── CLAUDE.md
├── package.json
├── main.js              # Electron 메인 프로세스 (ping, UDP, sound, settings)
├── preload.js           # contextBridge API (main↔renderer IPC)
├── renderer/
│   ├── index.html       # 메인 UI
│   ├── renderer.js      # UI 로직 및 IPC 호출
│   └── styles.css       # 스타일시트
├── assets/
│   ├── icon.ico         # 앱 아이콘
│   ├── app_icon.png     # 앱 아이콘 (PNG)
│   └── failed.wav       # 경보음 파일
└── settings.json        # 사용자 설정 (런타임 생성)
```

## 아키텍처 원칙
- **Main process**: ping 실행, UDP 소켓, 파일 I/O, 사운드 재생 등 시스템 작업 담당
- **Renderer process**: UI 렌더링만 담당, contextBridge를 통해 main과 통신
- **IPC 통신**: preload.js의 contextBridge로 안전하게 API 노출
- **설정 파일**: exe와 같은 디렉토리의 settings.json (portable 호환)

## 빌드 및 실행
```bash
npm install              # 의존성 설치
npm start                # 개발 모드 실행
npm run build            # Windows portable exe 빌드
```

## 코딩 컨벤션
- UI 텍스트는 한국어
- 변수/함수명은 영어 camelCase
- 설정 JSON 키는 snake_case (기존 호환)
- 에러 처리: 사용자에게 영향 없이 콘솔 로깅
- ping은 Windows `ping -n 1` 명령 사용

## 주요 기능
1. **감시 대상 관리**: 최대 20개, 활성화/비활성화 가능
2. **실시간 ping**: 설정 주기(초)마다 각 대상 ping
3. **상태 표시**: 성공(흰색), 장애(빨간색), 비활성화(회색)
4. **장애 로그**: 최근 100건 표시
5. **UDP 알림**: 장애/정상 시 설정된 주소로 UDP 메시지 전송
6. **경보음**: 장애 감지 시 WAV 파일 재생 (음소거 가능)
7. **설정 저장**: JSON 파일로 영속 저장

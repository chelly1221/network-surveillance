# PingTester

네트워크 감시 프로그램

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)

## 개요

최대 20개 네트워크 장비에 대한 실시간 ICMP ping 모니터링 프로그램입니다. 장애 발생 시 경보음 재생, UDP 알림 전송, 로그 기록 기능을 제공합니다.

## 주요 기능

- **실시간 Ping 감시** — 설정 주기(초)마다 각 대상에 ICMP ping 수행
- **2D 토폴로지 시각화** — Canvas 2D 기반 토폴로지 뷰 (테이블 뷰와 전환 가능), 미등록 노드 목록 표시
- **물리 토폴로지 편집** — 캔버스 기반 장비 배치 및 물리 연결 편집, HiDPI 지원
- **패킷 캡처** — Npcap 기반 실시간 IPv4 트래픽 모니터링, 다중 어댑터 동시 캡처, ASTERIX 프로토콜 감지
- **장애 감지 및 경보** — 장애 발생 시 경보음(WAV) 재생, 음소거 지원
- **UDP 알림** — 장애/복구 시 지정 주소로 UDP 메시지 자동 전송
- **장애 로그** — 최근 100건 장애 이력 실시간 표시 (상태 전환 시에만 기록)
- **설정 영속 저장** — 모든 설정을 JSON 파일로 atomic write 저장

## 스크린샷

### 테이블 뷰
감시 대상의 이름, 주소, 상태, 최종 갱신 시각을 테이블 형태로 표시합니다.

### 2D 토폴로지 뷰
장비 토폴로지를 Canvas 2D로 시각화하며, 상태에 따라 노드 색상이 변화합니다.

| 상태 | 노드 색상 |
|------|-----------|
| 정상 | 흰색 |
| 장애 | 빨간색 |
| 비활성화 | 회색 |

## 설치 및 실행

### 요구사항

- [Node.js](https://nodejs.org/) 18+
- Windows OS
- [Npcap](https://npcap.com/) (패킷 캡처 기능 사용 시, 선택사항)

### 개발 모드

```bash
npm install
npm start
```

### 빌드 (Portable .exe)

```bash
npm run build
```

빌드 결과물은 `dist/PingTester-{version}.exe`에 생성됩니다. 별도 설치 없이 실행 가능한 portable 파일입니다.

#### WSL2 환경에서 빌드

WSL2에서는 wine이 없어 직접 빌드가 실패하므로 `cmd.exe`를 경유합니다:

```bash
cmd.exe /c "cd /d C:\code\pingtester && npm run build"
```

## 사용법

1. **감시대상 설정** — 상단 메뉴 `감시대상` 클릭 후 장치 이름, IP 주소, 활성화 여부 설정
2. **탐색주기 설정** — `주기` 메뉴에서 ping 간격(초) 설정
3. **UDP 설정** — `UDP` 메뉴에서 알림 수신 IP/포트 및 메시지 설정
4. **경보 설정** — `경보` 메뉴에서 경보음 파일 선택 및 테스트
5. **캡처 설정** — `캡처` 메뉴에서 네트워크 어댑터 선택 (복수 선택 가능, Npcap 필요)
6. **토폴로지 편집** — `토폴로지` 메뉴에서 장비 배치 및 물리 연결 설정
7. **감시 시작** — 하단 `시작` 버튼 클릭
8. **뷰 전환** — 감시 현황 패널 헤더의 토글 버튼으로 테이블/2D 뷰 전환

## 기술 스택

| 구분 | 기술 |
|------|------|
| Runtime | Electron (Node.js) |
| UI | HTML + CSS (프레임워크 없음) |
| 2D 시각화 | Canvas 2D |
| Language | JavaScript (ES Modules in renderer, CommonJS in main) |
| Build | electron-builder |
| Platform | Windows |

## 프로젝트 구조

```
pingtester/
├── main.js              # Electron 메인 프로세스 (ping, UDP, sound, capture)
├── preload.js           # contextBridge IPC API
├── renderer/
│   ├── index.html       # 메인 UI (테이블 + 2D 토폴로지 뷰, ARIA 접근성 적용)
│   ├── renderer.js      # UI 로직 및 IPC 호출
│   ├── styles.css       # 스타일시트 (WCAG AA 대비 준수)
│   ├── view2d.js        # Canvas 2D 토폴로지 시각화 + 미등록 노드
│   └── topoEditor.js    # 캔버스 기반 토폴로지 편집기 (HiDPI 지원)
├── assets/
│   ├── icon.ico         # 앱 아이콘
│   ├── app_icon.png     # 앱 아이콘 (PNG)
│   └── failed.wav       # 기본 경보음
├── package.json
└── settings.json        # 사용자 설정 (런타임 자동 생성)
```

## 보안

- IPC 통신: contextBridge를 통한 안전한 API 노출
- 입력 검증: 주소, IP, 포트, 메시지 길이 등 서버사이드 검증
- 프로토타입 오염 방어: 재귀적 sanitization + 허용 키 목록 필터링
- 설정 파일 로드 시 키 허용 목록(allowlist) 적용
- XSS 방어: HTML 이스케이프 (escapeHtml, escapeAttr)
- CSP: Content Security Policy 적용

## 라이선스

UNLICENSED — 내부 사용 전용

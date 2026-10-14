<div align="center">

# ⬇️ DownDock

**작업표시줄을 대체하는 하단 독**

앱 실행 · 미디어 제어 · 인터넷 기반 AI —<br/>
당신의 화면 맨 아래, 하나의 유리 독 안에.

[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?logo=windows11&logoColor=white)](https://github.com/MoRinGnA/DownDock)
[![Tauri 2](https://img.shields.io/badge/UI-Tauri%202%20%2B%20React-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Backend-Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)

<sub>시스템 WebView2 사용 · Electron 대비 상주 메모리 小 · Tauri 2 + React + Tailwind</sub>

</div>

---

> [!TIP]
> **한 줄 요약** — 화면 맨 아래 유리 독 하나가, 작업표시줄을 대신해 앱과 실행 중인 창을 나란히 놓습니다.
> 아이콘을 누르면 열고, 앞으로 나와 있는 창을 누르면 최소화됩니다.

## 📖 목차

- [왜 필요한가요?](#-왜-필요한가요)
- [기능](#-기능)
- [시작하기](#-시작하기)
- [설정](#️-설정)
- [기술 구조](#-기술-구조)
- [로드맵](#-로드맵)

---

## 🤔 왜 필요한가요?

작업표시줄은 화면 밑을 영구히 차지합니다. 27인치 화면에서 48px는 그냥 사라지는 공간이고,
최대화된 창은 그 위에 얹힙니다.

**DownDock은 그 자리를 되찾습니다.** 독은 화면 하단에 고정되어 있고, 작업 영역을 비워 둔 덕분에
최대화된 창도 독을 덮지 않습니다. 커서 근접 자동 표시나 마그니피케이션처럼 독이 움직이는 장식은 없습니다.

---

## ✨ 기능 (1차 마일스톤)

| 기능 | 설명 |
|---|---|
| **하단 독** | 화면 하단 중앙, 최상단 고정. 커서 근접 자동 표시 없이 아이콘은 항상 같은 크기 |
| **작업표시줄 연동** | 실행 중인 창을 아이콘과 함께 나열, 누르면 전환 / 이미 앞으로 나와 있으면 최소화 |
| **유리 디자인** | 백드롭 블러 + 다층 하이라이트. 호버 장식(Shine·툴팁) 없이 독은 항상 같은 모양 |
| **앱 실행기** | 시작 메뉴 전체(.lnk)를 아이콘과 함께 나열, 이름 검색, Enter로 실행 |
| **고정 목록** | 자주 쓰는 앱을 독에 고정 (`config.json`에 저장) |
| **작업 영역 점유** | 화면 하단을 작업 영역에서 비워 최대화 창이 독을 덮지 않게 함 (릴리스 기본) |
| **앱 전환기 제외** | Alt+Tab에 뜨지 않는 도구 창 스타일. 터치 영역은 독 본체에만 한정 |
| **트레이** | 트레이 우클릭 → 종료 |

---

## 🚀 시작하기

### 필요 환경

- Windows 10/11
- [Rust](https://rustup.rs/) (stable, MSVC 도구 링크 포함)
- Visual Studio Build Tools (C++ 워크로드)
- Node.js 20+

### 빌드 · 실행

```powershell
npm install
npm run tauri dev      # 개발 실행
npm run tauri build    # 설치 파일( 번들 ) 생성
```

아이콘은 `scripts/gen-icon.mjs`가 코드로 그립니다.

```powershell
node scripts/gen-icon.mjs
npm run tauri icon assets/icon.png
```

---

## ⚙️ 설정

`%APPDATA%\DownDock\config.json`

```json
{
  "pinned": ["C:\\...\\Visual Studio Code.lnk"],
  "reserveWorkArea": true
}
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `pinned` | 자주 쓰는 앱 자동 선택 | 독에 고정한 바로 가기 경로 목록 |
| `reserveWorkArea` | 릴리스: `true` / 디버그: `false` | 화면 하단 작업 영역을 비울지 여부 |

> [!WARNING]
> `reserveWorkArea`는 종료 시 원래 작업 영역으로 되돌립니다. 프로세스를 강제 종료하면
> 화면 하단이 비어 있는 채 남을 수 있습니다 — 트레이 메뉴로 종료하세요. (설정 창은 후속 마일스톤)

---

## 🧱 기술 구조

```
DownDock/
├── src/                    # React + Tailwind 프런트엔드 (도크·실행기 UI)
│   ├── App.tsx             # 창 크기 동기화, 실행 중인 창 목록
│   └── components/
│       ├── Dock.tsx        # 고정 앱 + 실행 중인 창 아이콘 줄
│       └── LauncherPanel.tsx
└── src-tauri/              # Rust 백엔드 (Win32 직접 호출)
    ├── src/win.rs          # 최상단·하단 배치·작업영역 점유·창 목록 열거
    ├── src/apps.rs         # 시작 메뉴 열거·아이콘 추출·셸 실행
    └── src/config.rs       # config.json 저장/불러오기
```

- **창 관리**: `SetWindowPos(HWND_TOPMOST)`를 0.5초마다 되새겨 최상단을 지킵니다.
  창 목록이 바뀌면 `windows:changed` 이벤트로 프런트엔드에 알립니다.
- **작업표시줄 연동**: `EnumWindows`로 실행 중인 창을 걸러(도구 창·가려진 창 제외)
  프로세스 exe에서 아이콘을 추출합니다. 누르면 `SetForegroundWindow`, 이미 앞으로 나와 있으면 `ShowWindow(SW_MINIMIZE)`.
- **아이콘**: `windows-icons`로 추출해 `%APPDATA%\DownDock\icons`에 PNG 캐시.
- **창 크기**: 프런트엔드가 그린 내용물 크기를 `resize_dock`으로 알려 주면 창이 그에 맞춰 줄어듭니다.
  창이 여유롭게 커지면 보이지 않는 여백이 바탕화면의 클릭을 먹기 때문입니다.

---

## 🗺️ 로드맵

- [x] 실행 중인 앱 표시·전환(작업표시줄 연동)
- [ ] 미디어 컨트롤 (GlobalSystemMediaTransportControls — 재생/정지/트랙/볼륨)
- [ ] 인터넷 기반 AI 어시스턴트 (Google Gemini + 웹 검색)
- [ ] 고정 목록 편집 UI (실행기 우클릭으로 고정/해제, 순서 변경)
- [ ] 설정 창 (고정 목록 편집, 테마, 단축키)
- [ ] 다중 모니터 지원
- [ ] UWP(마이크로소프트 스토어) 앱 열거 (`AppsFolder`)

---

## 📄 라이선스

개인 프로젝트. 배포 없이 사용합니다.

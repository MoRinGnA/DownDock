<div align="center">

# ⬇️ DownDock

**화면 오른쪽 가장자리에 붙는 세로 노치 독**

앱 실행 · 실행 중인 창 전환 —<br/>
화면 오른쪽 가장자리에 붙는 유리 노치 안에.

[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?logo=windows11&logoColor=white)](https://github.com/MoRinGnA/DownDock)
[![Tauri 2](https://img.shields.io/badge/UI-Tauri%202%20%2B%20React-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Backend-Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)

<sub>시스템 WebView2 사용 · Electron 대비 상주 메모리 小 · Tauri 2 + React + Tailwind</sub>

</div>

---

> [!TIP]
> **한 줄 요약** — Windows 작업표시줄 자동 숨김을 선택한 사용자는 앱과 실행 중인 창을 화면 오른쪽 노치에서 모아 쓸 수 있습니다.
> DownDock은 작업표시줄 설정을 변경하지 않으며, 아이콘을 누르면 앱을 열거나 창을 전환합니다.

## 📖 목차

- [왜 필요한가요?](#-왜-필요한가요)
- [기능](#-기능)
- [시작하기](#-시작하기)
- [설정](#️-설정)
- [기술 구조](#-기술-구조)
- [로드맵](#-로드맵)

---

## 🤔 왜 필요한가요?

DownDock은 화면 가장자리(기본 왼쪽)에 붙는 세로형 노치입니다. Windows 작업표시줄을 자동 숨김으로 설정하면 화면 공간을 더 넓게 쓸 수 있지만, DownDock은 그 설정을 대신 바꾸거나 강제하지 않습니다.
평소에는 20px 폭의 얇은 레일만 남습니다. 위쪽 막대는 창 하나당 하나라, 막대를 누르면 그 창으로 바로 전환됩니다.
막대는 열린 순서를 그대로 유지하고(활성 창이 바뀌어도 자리가 바뀌지 않음), 앱마다 색이 고정되며 지금 보는 창만 두껍고 밝게 표시됩니다.
아래쪽에는 볼륨을 세로 게이지로, 배터리를 25%짜리 막대 네 개로 표시합니다.
손잡이(‹)를 누르면 높이는 그대로 두고 폭만 넓어져, 열린 창 목록과 창·앱 통합 검색이 펼쳐집니다.
검색창에서 ↑↓로 고르고 Enter로 전환·실행하며, Esc나 바깥 클릭으로 닫습니다(포인터가 벗어났다고 저절로 접히지 않습니다).

---

## ✨ 기능 (1차 마일스톤)

| 기능 | 설명 |
|---|---|
| **세로 노치 독** | 화면 가장자리(기본 왼쪽)에 밀착, 화면 높이 중앙에 배치. 설정에서 좌/우 변경. Windows 작업표시줄 설정은 변경하지 않음 |
| **20px 대기 레일** | 창 하나당 막대 하나 — 누르면 그 창으로 전환. 순서는 고정, 앱마다 색이 다르고 지금 보는 창만 길게 |
| **통합 검색 패널** | 레일과 같은 높이로 펼쳐져 열린 창 + 앱을 한 입력창에서 검색(↑↓ · Enter) |
| **유리 디자인** | 백드롭 블러 + 다층 하이라이트. 호버 장식(Shine·툴팁) 없이 독은 항상 같은 모양 |
| **앱 실행기** | 시작 메뉴 전체(.lnk)를 아이콘과 함께 나열, 이름 검색, Enter로 실행 |
| **고정 목록** | 자주 쓰는 앱을 독에 고정 (`config.json`에 저장) |
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
  "pinned": ["C:\\...\\Visual Studio Code.lnk"]
}
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `pinned` | 빈 목록 | 독에 고정한 바로 가기 경로 목록 |

DownDock은 Windows 작업 영역이나 작업표시줄 설정을 수정하지 않으므로 강제 종료 후에도 해당 시스템 상태를 복구할 필요가 없습니다.

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
    ├── src/win.rs          # 오른쪽 가장자리 배치·실행 중인 창 목록 열거
    ├── src/apps.rs         # 시작 메뉴 열거·아이콘 추출·셸 실행
    └── src/config.rs       # config.json 저장/불러오기
```

- **창 배치**: 화면 오른쪽 중앙에 노치 독을 배치합니다. Windows 작업표시줄 자동 숨김은 사용자가 직접 설정합니다. Windows 작업 영역을 수정하지 않으며, 항상 위 창의 순서는 셸이 활성화될 때 보장되지 않습니다.
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

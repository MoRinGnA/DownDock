import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type AppEntry,
  type RunningWindow,
  type Shape,
  type Side,
  type Theme,
  type TrayApp,
  type Vertical,
  activateWindow,
  captureWindow,
  closeWindow,
  focusWindow,
  getAutostart,
  getConfig,
  launchApp,
  listApps,
  listRunningWindows,
  listTrayApps,
  minimizeWindow,
  minimizeWindows,
  restoreWindows,
  resizeDock,
  saveAutostart,
  saveRailHeight,
  saveShape,
  saveShortcut,
  saveSide,
  saveTheme,
  saveVertical,
  setPinned,
} from "./lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Dock from "./components/Dock";
import SettingsPanel from "./components/SettingsPanel";
import { groupFolds, groupWindows, useStableWindows, type WindowGroup } from "./lib/windows";

// Dock 창은 보이는 요소 주변의 최소 여유만 두어 바탕화면 클릭을 가리지 않는다.
const EDGE_ROOM = 12;
const CROSS_AXIS_ROOM = 12;
const PANEL_GAP = 10;

// 브라우저에서 열어 스타일만 확인할 때 쓰는 가상 앱. 타우리 밖에서는 진짜 목록이 없다.
const DEMO_ICONS = ["#4f9dff", "#a78bfa", "#f472b6", "#f87171", "#fbbf24", "#34d399"];
// 브라우저 데모에는 창 캡처가 없다. 카드 모양을 확인할 수 있도록 가짜 창 그림을 만든다.
function demoThumb(seed: number): string {
  const hue = (seed * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 170">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 42% 27%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 45) % 360} 38% 14%)"/>
    </linearGradient></defs>
    <rect width="300" height="170" fill="url(#g)"/>
    <rect x="18" y="22" width="118" height="8" rx="4" fill="rgba(255,255,255,.3)"/>
    <rect x="18" y="44" width="206" height="6" rx="3" fill="rgba(255,255,255,.16)"/>
    <rect x="18" y="58" width="168" height="6" rx="3" fill="rgba(255,255,255,.12)"/>
    <rect x="18" y="88" width="264" height="62" rx="10" fill="rgba(255,255,255,.07)"/>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// 브라우저 데모의 트레이 앱. 실제 타우리에서는 레지스트리에서 읽는다.
const DEMO_TRAY: TrayApp[] = ["KakaoTalk", "Discord"].map((name, i) => ({
  id: `tray-demo-${i}`,
  name,
  exe: `C:\\Demo\\${name}.exe`,
  icon: `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="14" fill="${DEMO_ICONS[i + 4]}"/><text x="24" y="32" font-size="22" text-anchor="middle" fill="#0b0c10" font-family="sans-serif" font-weight="700">${name[0]}</text></svg>`,
  )}`,
}));

const DEMO_APPS: AppEntry[] = ["Chrome", "Code", "Explorer", "Terminal", "Notepad", "Spotify"].map(
  (name, i) => ({
    id: `demo-${i}`,
    name,
    path: `demo-path-${i}`,
    icon: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="14" fill="${DEMO_ICONS[i]}"/><text x="24" y="32" font-size="22" text-anchor="middle" fill="#0b0c10" font-family="sans-serif" font-weight="700">${name[0]}</text></svg>`,
    )}`,
  }),
);

export default function App() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [pinnedPaths, setPinnedPaths] = useState<string[]>([]);
  const [windows, setWindows] = useState<RunningWindow[]>([]);
  // 화면에 창 없이 트레이에만 남은 프로그램(^ 안의 아이콘).
  const [trayApps, setTrayApps] = useState<TrayApp[]>([]);
  // 레일과 목록이 쓰는 순서. 활성 창이 바뀌어도 자리가 그대로다.
  const running = useStableWindows(windows);
  // 레일은 앱 단위로 묶는다. 목록(시작 메뉴)은 창 단위 그대로 두어 검색이 정확하다.
  const groups = useMemo(() => groupWindows(running), [running]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dockMaxHeight, setDockMaxHeight] = useState(760);
  const [panelView, setPanelView] = useState<"apps" | "settings">("apps");
  const [theme, setThemeState] = useState<Theme>("system");
  const [shortcut, setShortcutState] = useState("Ctrl+Alt+D");
  // 표면 모양: 둥근 유리 ↔ 모서리를 깎은 각진 유리.
  const [shape, setShapeState] = useState<Shape>("round");
  // 독이 붙는 화면 가장자리. 오른쪽은 창 스크롤바를 가려서 왼쪽이 기본.
  const [side, setSideState] = useState<Side>("left");
  // 화면에서 독이 놓이는 세로 위치(위·가운데·아래).
  const [vertical, setVerticalState] = useState<Vertical>("bottom");
  // 접힌 레일의 세로 길이. 설정에서 바꾸며, 창이 많으면 이보다 길어진다.
  const [railHeight, setRailHeight] = useState(340);
  // 로그온 자동 시작. 화면에는 설정 파일이 아니라 OS에 실제로 등록된 상태를 보여 준다.
  const [autostart, setAutostart] = useState(false);
  // 실제 적용 테마가 라이트일 때만 리퀴드 글래스 셰이더를 켠다.
  const [lightMode, setLightMode] = useState(false);
  // "자동" 테마가 쓰는 값. 독 뒤 배경이 어둡다고 판단되면 true.
  const [autoDark, setAutoDark] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // 레일 막대 위 미리보기. 캡처는 한 번 받아 두고 10초 동안 재사용한다.
  const [preview, setPreview] = useState<{
    hwnd: number;
    title: string;
    icon: string | null;
    top: number;
  } | null>(null);
  const [previewShot, setPreviewShot] = useState<string | null>(null);
  // 창이 여러 개인 앱에 올렸을 때 띄우는 창 목록 카드.
  const [groupCard, setGroupCard] = useState<{ group: WindowGroup; top: number } | null>(null);
  // 창 우클릭 메뉴. 접힌 레일(23px)에는 그릴 자리가 없어, 미리보기처럼 옆 칸을 쓴다.
  const [windowMenu, setWindowMenu] = useState<{
    hwnd: number;
    // 창이 속한 앱(그룹 키). 여러 창을 가진 앱이면 메뉴에서 그룹 전체도 다룰 수 있다.
    key: string;
    title: string;
    icon: string | null;
    minimized: boolean;
    top: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const shots = useRef(new Map<number, { at: number; url: string }>());
  // 그룹을 통째로 펼 때 마지막에 쓰던 창을 맨 앞에 두기 위해 앱별로 기억한다.
  // 전부 접히면 지금 활성 표시가 사라지므로, 접히기 전 값을 남겨 둬야 한다.
  const lastActive = useRef(new Map<string, number>());
  const previewHwnd = useRef<number | null>(null);
  const previewTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  // 단축키를 녹음하는 동안에는 전역 단축키 이벤트를 무시한다. 녹음 중에 같은 조합을
  // 누르면 패널이 닫히면서 녹음 자체가 사라지던 문제를 막는다.
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const recordingRef = useRef(recordingShortcut);
  recordingRef.current = recordingShortcut;
  const panelOpenRef = useRef(false);

  useEffect(() => {
    for (const group of groups) {
      const focused = group.windows.find((win) => win.active);
      if (focused) lastActive.current.set(group.key, focused.hwnd);
    }
  }, [groups]);

  const pinned = useMemo(() => {
    const byPath = new Map(apps.map((a) => [a.path, a]));
    return pinnedPaths
      .map((path) => byPath.get(path))
      .filter((app): app is AppEntry => !!app);
  }, [apps, pinnedPaths]);

  useEffect(() => {
    if (!isTauri()) {
      setApps(DEMO_APPS);
      setTrayApps(DEMO_TRAY);
      setPinnedPaths(DEMO_APPS.map((a) => a.path));
      // 데모 창은 일부러 Code를 두 개 둔다 — 같은 앱의 창이 레일에서 한 칸으로
      // 묶이고, 올리면 창 목록이 뜨는지 확인할 수 있다. 제목도 페이지 제목처럼
      // 앱 이름이 없는 것을 섞어 목록의 보충 표시를 볼 수 있게 한다.
      const [chrome, code, explorer] = DEMO_APPS;
      setWindows([
        {
          hwnd: 1001,
          title: "GitHub — Chrome",
          exe: "C:\\Demo\\Chrome.exe",
          icon: chrome.icon,
          active: true,
          minimized: false,
        },
        {
          hwnd: 1002,
          title: "main.rs — DownDock",
          exe: "C:\\Demo\\Code.exe",
          icon: code.icon,
          active: false,
          minimized: false,
        },
        {
          hwnd: 1003,
          title: "build.rs — DownDock",
          exe: "C:\\Demo\\Code.exe",
          icon: code.icon,
          active: false,
          minimized: false,
        },
        {
          hwnd: 1004,
          title: "다운로드",
          exe: "C:\\Demo\\Explorer.exe",
          icon: explorer.icon,
          active: false,
          minimized: true,
        },
      ]);
      return;
    }
    let disposed = false;
    (async () => {
      const [all, config] = await Promise.all([
        listApps(),
        // 설정 파일이 손상돼도 실행기는 떠야 한다. 설정만 기본값으로 둔다.
        getConfig().catch(() => null),
      ]);
      if (disposed) return;
      setApps(all);
      if (config) {
        setPinnedPaths(config.pinned);
        setThemeState(config.theme);
        setShortcutState(config.shortcut);
        // 예전 설정 파일에는 모양·위치 항목이 없다.
        if (config.shape) setShapeState(config.shape);
        if (config.side) setSideState(config.side);
        if (config.vertical) setVerticalState(config.vertical);
        if (config.railHeight) setRailHeight(config.railHeight);
        // 설정 파일과 OS 등록이 어긋날 수 있다(레지스트리에서 지워지거나 PC 이동).
        // 실제 등록 상태를 먼저 믿고, 못 읽을 때만 설정 값을 쓴다.
        getAutostart()
          .then((on) => {
            if (!disposed) setAutostart(on);
          })
          .catch(() => setAutostart(config.autostart));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // 표면 모양은 CSS가 data-shape로 읽는다(둥근 모서리 ↔ 45도 챔퍼).
  useEffect(() => {
    document.documentElement.dataset.shape = shape;
  }, [shape]);

  // 테마: system이면 OS 설정을 따라가며, 실제 적용 값(light|dark)을 data-theme에 적는다.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light =
        theme === "light" ||
        (theme === "system" && mql.matches) ||
        // 자동: 독 뒤 배경이 밝을 때만 라이트.
        (theme === "auto" && !autoDark);
      document.documentElement.dataset.theme = light ? "light" : "dark";
      setLightMode(light);
    };
    apply();
    if (theme !== "system") return;
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [theme, autoDark]);

  // 전역 단축키(러스트 쪽 등록)가 보내는 토글 신호. 패널을 여닫는다.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen("launcher:toggle", () => {
      if (recordingRef.current) return;
      const next = !panelOpenRef.current;
      setPanelOpen(next);
      setQuery("");
      if (next) {
        setPanelView("apps");
        // 단축키로 열면 창이 뒤에 있을 수 있다. 앞으로 가져와야 검색어를 바로 입력할 수 있다.
        getCurrentWindow().setFocus().catch(() => {});
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // 패널을 닫으면 설정 화면에서 나온 상태로 되돌린다.
  useEffect(() => {
    if (!panelOpen) setPanelView("apps");
  }, [panelOpen]);

  // 트레이 앱은 프로세스 목록이라 이벤트가 없다. 10초마다 가볍게 다시 읽는다
  // (아이콘은 파일 캐시에서 오므로 매번 추출하지 않는다).
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const load = () => {
      listTrayApps()
        .then((list) => {
          if (!disposed) setTrayApps(list);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  // 실행 중인 창: 러스트가 목록이 바뀔 때만 알린다. 매초 새로고침하지 않아도 된다.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const refresh = () => {
      listRunningWindows()
        .then((list) => {
          if (!disposed) setWindows(list);
        })
        .catch(() => {});
    };
    refresh();
    const unlisten = listen("windows:changed", refresh);
    return () => {
      disposed = true;
      unlisten.then((off) => off());
    };
  }, []);

  // 기본은 20px 대기 레일. 누르면 같은 높이 그대로 시작 메뉴로 펼쳐진다.
  const menuOpen = panelOpen && panelView === "apps";
  panelOpenRef.current = panelOpen;

  // 접힌 레일에서는 투명 여백을 4px로 줄인다. 시작 메뉴나 설정이 열려 있을 때는
  // 패널과 같은 여백을 써서 두 표면이 같은 선에 서게 한다.
  const dockThin = !panelOpen;
  // 레일과 시작 메뉴는 높이가 같다. 그래야 펼칠 때 창이 세로로 흔들리지 않는다.
  const dockHeight = Math.max(240, dockMaxHeight - EDGE_ROOM * 2);
  const sideRoom = dockThin ? 4 : CROSS_AXIS_ROOM;
  // 화면 세로 위치에 맞춰 내용물을 창 안에서 위/가운데/아래로 정렬한다.
  const verticalAlign =
    vertical === "top" ? "items-start" : vertical === "center" ? "items-center" : "items-end";
  const sideRoomRef = useRef(sideRoom);
  sideRoomRef.current = sideRoom;

  // 창 크기를 내용물에 맞춘다. 실행기 검색어가 바뀔 때마다 길이도 바뀐다.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (!isTauri()) return;
    let disposed = false;
    let raf = 0;
    // 패널이 나중에 커지거나 목록이 다 그려진 뒤에도 창 크기를 다시 맞춘다.
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const dock = el.querySelector<HTMLElement>(".dock-shell");
        if (!rect.width || !rect.height || !dock) return;
        // 접힌 동안에는 투명 여백도 줄인다. 여백은 클릭을 먹기 때문에 얇은 만큼만 둔다.
        const room = sideRoomRef.current;
        resizeDock(
          Math.ceil(rect.width) + room * 2,
          Math.ceil(rect.height) + EDGE_ROOM * 2,
          side,
          // 독의 세로 위치 설정을 창 배치에도 그대로 쓴다.
          vertical,
        )
          .then((maxHeight) => {
            if (!disposed) setDockMaxHeight(maxHeight);
          })
          .catch(() => {});
      });
    };
    const observer = new ResizeObserver(sync);
    observer.    observe(el);
    sync();
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [apps.length, pinned.length, running.length, panelOpen, panelView, query, dockThin, side, vertical]);

  // 실행기: 패널이 열려 있는 동안만 Esc를 받아 닫는다.
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    // 브라우저 데모에는 창 포커스 개념이 없어서, 탭을 벗어났다고 닫으면 확인이 불가능하다.
    const onBlur = () => {
      if (isTauri()) setPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [panelOpen]);

  // 고정 목록을 낙관적으로 갱신하고 저장한다. 저장에 실패하면 이전 목록으로 되돌린다.
  const savePinned = (next: string[]) => {
    const prev = pinnedPaths;
    setPinnedPaths(next);
    if (isTauri()) setPinned(next).catch(() => setPinnedPaths(prev));
  };

  const togglePin = (app: AppEntry) => {
    if (pinnedPaths.includes(app.path)) {
      savePinned(pinnedPaths.filter((p) => p !== app.path));
    } else {
      savePinned([...pinnedPaths, app.path]);
    }
  };

  // 독에 보이는 순서(pinned) 기준으로 이웃과 자리를 바꾼다.
  const movePinned = (app: AppEntry, delta: -1 | 1) => {
    const pos = pinned.findIndex((a) => a.path === app.path);
    const other = pinned[pos + delta];
    if (pos < 0 || !other) return;
    const next = [...pinnedPaths];
    const i = next.indexOf(app.path);
    const j = next.indexOf(other.path);
    [next[i], next[j]] = [next[j], next[i]];
    savePinned(next);
  };

  // 테마 저장 실패 시 이전 값으로 되돌린다.
  const changeTheme = (next: Theme) => {
    const prev = theme;
    setThemeState(next);
    if (isTauri()) saveTheme(next).catch(() => setThemeState(prev));
  };

  // 자동 시작은 OS 등록이 성공해야 화면도 바뀐다. 실패하면 이전 값으로 되돌린다.
  const changeAutostart = (next: boolean) => {
    const prev = autostart;
    setAutostart(next);
    if (!isTauri()) return;
    saveAutostart(next)
      .then((actual) => setAutostart(actual))
      .catch(() => setAutostart(prev));
  };

  const changeShape = (next: Shape) => {
    const prev = shape;
    setShapeState(next);
    if (isTauri()) saveShape(next).catch(() => setShapeState(prev));
  };

  // 저장 실패 시 이전 가장자리로 되돌린다.
  const changeSide = (next: Side) => {
    const prev = side;
    setSideState(next);
    if (isTauri()) saveSide(next).catch(() => setSideState(prev));
  };

  const changeVertical = (next: Vertical) => {
    const prev = vertical;
    setVerticalState(next);
    if (isTauri()) saveVertical(next).catch(() => setVerticalState(prev));
  };

  // 슬라이더를 끄는 동안 바로 반영한다. 저장 파일이 작아 매 단계 기록해도 부담이 없다.
  const changeRailHeight = (next: number) => {
    const prev = railHeight;
    setRailHeight(next);
    if (isTauri()) saveRailHeight(next).catch(() => setRailHeight(prev));
  };

  // 단축키 저장은 러스트가 등록을 확인한 뒤에야 성공한다. 실패 사유는 호출한 쪽이 보여 준다.
  const changeShortcut = (combo: string) => {
    if (!isTauri()) {
      setShortcutState(combo);
      return Promise.resolve();
    }
    return saveShortcut(combo).then(() => setShortcutState(combo));
  };

  // 자동 테마에서는 밝든 어둡든 유리 굴절을 유지한다(배경이 바뀌어도 유리 느낌은 같다).
  const glassOn = theme === "auto" ? true : lightMode;

  // 막대 위에 머무를 때만 캡처한다. 스쳐 지나가면 창을 만들지 않는다.
  const showPreview = (win: RunningWindow | null, top = 0) => {
    if (!win) {
      hidePreview();
      return;
    }
    // 우클릭 메뉴가 떠 있는 동안에는 미리보기를 띄우지 않는다. 둘 다 옆 칸을 쓰므로
    // 같이 뜨면 창이 쓸데없이 넓어지고 어느 창을 다루는지도 흐려진다.
    if (windowMenu) return;
    // 다른 앱으로 옮겼으면 창 목록 카드는 접는다.
    setGroupCard(null);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    previewHwnd.current = win.hwnd;
    setPreview({ hwnd: win.hwnd, title: win.title || win.exe, icon: win.icon, top });

    const cached = shots.current.get(win.hwnd);
    if (cached && Date.now() - cached.at < 10_000) {
      setPreviewShot(cached.url);
      return;
    }
    setPreviewShot(null);
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    if (!isTauri()) {
      setPreviewShot(demoThumb(win.hwnd));
      return;
    }
    previewTimer.current = window.setTimeout(() => {
      captureWindow(win.hwnd)
        .then((url) => {
          shots.current.set(win.hwnd, { at: Date.now(), url });
          // 그사이 다른 막대로 옮겼으면 버린다.
          if (previewHwnd.current === win.hwnd) setPreviewShot(url);
        })
        // 캡처가 안 되는 창(최소화·보호된 창)은 제목만 보여 준다.
        .catch(() => {});
    }, 140);
  };

  const hidePreview = () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewHwnd.current = null;
    // 막대 사이를 옮길 때 창이 꾸준히 붙었다 떴다 하지 않도록 잠깐 기다린다.
    // 카드의 창 버튼까지 마우스가 건너갈 수 있게 여유를 둔다(카드에 들어오면 취소된다).
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setPreview(null);
      setPreviewShot(null);
      setGroupCard(null);
    }, 220);
  };

  // 창이 여러 개인 앱: 대표 창 하나 대신 창 목록을 띄워 고르게 한다.
  const showGroupCard = (group: WindowGroup, top: number) => {
    // 우클릭 메뉴가 떠 있으면 그쪽이 우선이다(메뉴는 사용자가 명시적으로 연 것).
    if (windowMenu) return;
    setPreview(null);
    setPreviewShot(null);
    previewHwnd.current = null;
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setGroupCard({ group, top });
  };

  // 그룹 알약 클릭: 작업표시줄의 그룹 버튼처럼 한 앱의 창을 통째로 다룬다.
  // - 지금 그 앱을 쓰고 있으면: 떠 있는 창을 전부 접는다.
  // - 아니면(다른 앱을 쓰거나 전부 접혀 있으면): 창을 전부 펴고 마지막에 쓰던 창을 올린다.
  const toggleGroup = (group: WindowGroup) => {
    setGroupCard(null);
    const visible = group.windows.filter((win) => !win.minimized);
    const fold = groupFolds(group);
    // 펼 때 맨 앞에 둘 창: 지금 쓰는 창이 있으면 그 창, 아니면 마지막에 쓰던 창.
    // 기억한 창이 그새 닫혔을 수 있으니 그룹 안에 있는지 확인하고 고른다.
    const remembered = group.windows.find(
      (win) => win.hwnd === lastActive.current.get(group.key),
    );
    const focus = group.active ? group.lead.hwnd : (remembered ?? group.lead).hwnd;

    if (!isTauri()) {
      // 브라우저 데모도 같은 규칙으로 움직인다. 실제 창이 없으니 상태만 바꾼다.
      const inGroup = new Set(group.windows.map((win) => win.hwnd));
      setWindows((prev) =>
        prev.map((win) => {
          if (inGroup.has(win.hwnd)) {
            return { ...win, minimized: fold, active: !fold && win.hwnd === focus };
          }
          // 펼칠 때는 다른 앱의 활성 표시를 지운다. 접을 때는 그룹이 이미 전경이라
          // 건드릴 것이 없다.
          return fold ? win : { ...win, active: false };
        }),
      );
      return;
    }

    const action = fold
      ? minimizeWindows(visible.map((win) => win.hwnd))
      : restoreWindows(group.windows.map((win) => win.hwnd), focus);
    action.catch((err) => console.warn("그룹 전환 실패", err));
  };

  const focusFromGroup = (hwnd: number) => {
    // 목록에서 고르는 것은 '그 창으로 가라'는 뜻이라 최소화 토글이 아니라 활성화다.
    // 작업표시줄 미리보기처럼 그 창만 펴고, 그룹의 다른 창은 접힌 채로 둔다.
    if (isTauri()) activateWindow(hwnd).catch((err) => console.warn("창 전환 실패", err));
    else
      setWindows((prev) =>
        prev.map((win) => ({
          ...win,
          minimized: win.hwnd === hwnd ? false : win.minimized,
          active: win.hwnd === hwnd,
        })),
      );
    setGroupCard(null);
  };

  // 막대를 떠나 카드로 들어오는 동안 예약된 닫기를 취소한다.
  const keepPreview = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const dismissPreview = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    previewHwnd.current = null;
    setPreview(null);
    setPreviewShot(null);
    setGroupCard(null);
  };

  // 미리보기 카드에서 바로 창을 접거나 닫는다. 작업표시줄 미리보기의 ✕와 같은 동작이다.
  // 우클릭은 미리보기와 같은 자리를 쓰므로 하나만 띄운다. 메뉴가 떠 있는 동안
  // 미리보기가 따라다니면 어느 창을 다루는지 흐려진다.
  const openWindowMenu = (win: RunningWindow, top: number) => {
    dismissPreview();
    setWindowMenu({
      hwnd: win.hwnd,
      key: win.exe.toLowerCase(),
      title: win.title || win.exe,
      icon: win.icon,
      minimized: win.minimized,
      top,
    });
  };

  const menuFocus = () => {
    if (windowMenu && isTauri()) activateWindow(windowMenu.hwnd).catch(() => {});
    setWindowMenu(null);
  };

  // 최소화된 창은 '복원'을, 떠 있는 창은 '최소화'를 보여 준다. 복원은 focus_window가
  // 이미하고 있으므로 명령을 하나 더 두지 않는다.
  const menuMinimize = () => {
    if (windowMenu && isTauri()) {
      const action = windowMenu.minimized
        ? activateWindow(windowMenu.hwnd)
        : minimizeWindow(windowMenu.hwnd);
      action.catch((err) => console.warn("창 상태 변경 실패", err));
    }
    setWindowMenu(null);
  };

  const menuClose = () => {
    if (windowMenu && isTauri()) closeWindow(windowMenu.hwnd).catch(() => {});
    setWindowMenu(null);
  };

  // 메뉴의 창이 여러 창을 가진 앱의 것이면 그룹 전체 접기·펴기를 함께 보여 준다.
  // 창 목록 카드와 같은 동작(작업표시줄의 그룹 버튼)을 메뉴만으로도 쓸 수 있다.
  const menuGroup = useMemo(
    () =>
      windowMenu
        ? (groups.find(
            (group) => group.key === windowMenu.key && group.windows.length > 1,
          ) ?? null)
        : null,
    [groups, windowMenu],
  );

  const menuToggleGroup = () => {
    const group = menuGroup;
    setWindowMenu(null);
    if (group) toggleGroup(group);
  };

  // 카드는 열린 시점의 그룹을 담지만, 창 상태는 계속 갱신되는 목록을 따른다.
  // 창 순서는 열린 순서로 고정되므로 커서 아래에서 줄이 흔들리지 않는다.
  const cardGroup = groupCard
    ? (groups.find((group) => group.key === groupCard.group.key) ?? groupCard.group)
    : null;
  // 접기/펴기 문구는 레일 알약과 같은 판단을 쓴다.
  const foldCard = cardGroup ? groupFolds(cardGroup) : false;
  const foldMenu = menuGroup ? groupFolds(menuGroup) : false;

  // 메뉴가 열리면 첫 항목으로 포커스를 옮긴다. 그러지 않으면 Tab 순서가 목록 뒤로
  // 밀리고, 스크린리더도 메뉴가 열린 것을 바로 읽지 못한다(마우스로 열면 링은 안 보인다).
  useEffect(() => {
    if (windowMenu) menuRef.current?.querySelector<HTMLButtonElement>(".window-menu-item")?.focus();
  }, [windowMenu]);

  // 메뉴 밖을 누르거나 Esc를 누르면 닫힌다. 오른쪽 클릭은 mousedown 뒤에 오므로
  // 같은 클릭으로 열린 메뉴가 즉시 닫히지는 않는다.
  useEffect(() => {
    if (!windowMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWindowMenu(null);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".window-menu")) return;
      setWindowMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [windowMenu]);

  const closePreviewWindow = () => {
    if (!preview) return;
    if (isTauri()) closeWindow(preview.hwnd).catch((err) => console.warn("창 닫기 실패", err));
    dismissPreview();
  };

  const minimizePreviewWindow = () => {
    if (!preview) return;
    if (isTauri())
      minimizeWindow(preview.hwnd).catch((err) => console.warn("창 최소화 실패", err));
    dismissPreview();
  };

  // 설정 화면이거나 메뉴가 닫혔으면 미리보기를 남기지 않는다.
  // 창 목록에서 창을 골라 패널이 닫히면 줄이 사라져 mouseleave가 오지 않는다.
  useEffect(() => {
    if (panelOpen && panelView === "apps") return;
    previewHwnd.current = null;
    setPreview(null);
    setPreviewShot(null);
    setGroupCard(null);
  }, [panelOpen, panelView]);

  const launch = (app: AppEntry) => {
    if (isTauri() && app.path) launchApp(app.path).catch(() => {});
    setPanelOpen(false);
    setQuery("");
  };

  return (
    <div
      className={`fixed inset-y-0 flex ${verticalAlign} ${
        side === "left" ? "dock-left left-0 justify-start" : "dock-right right-0 justify-end"
      }`}
    >
      <div
        ref={contentRef}
        className={`flex h-fit ${verticalAlign}`}
        style={{
          // 접힌 레일은 화면 끝에서 6px 띄운 캡슐, 펼친 패널은 12px 여백을 둔다.
          paddingLeft: side === "left" ? (dockThin ? 6 : EDGE_ROOM) : sideRoom,
          paddingRight: side === "left" ? sideRoom : dockThin ? 6 : EDGE_ROOM,
          gap: PANEL_GAP,
          // 왼쪽 독은 DOM 순서([미리보기, 패널, 독])를 뒤집어 독을 화면 끝에 둔다.
          flexDirection: side === "left" ? "row-reverse" : "row",
        }}
      >
        {groupCard && cardGroup && (
          <div className="menu-slot">
            <div
              className="window-menu group-menu"
              style={{ "--menu-top": `${groupCard.top}px` } as CSSProperties}
              role="menu"
              aria-label={`${cardGroup.name} 창 ${cardGroup.windows.length}개`}
              // 미리보기와 같은 자리를 쓰므로, 막대에서 카드로 넘어오는 동안 닫히지 않게 한다.
              onMouseEnter={keepPreview}
              onMouseLeave={hidePreview}
            >
              <div className="window-menu-head">
                {cardGroup.icon && <img src={cardGroup.icon} alt="" draggable={false} />}
                <span>{cardGroup.name}</span>
                <span className="window-menu-count">{cardGroup.windows.length}</span>
              </div>
              {cardGroup.windows.map((win) => (
                <button
                  key={win.hwnd}
                  type="button"
                  role="menuitem"
                  className={`window-menu-item group-menu-row${win.active ? " is-current" : ""}${
                    win.minimized ? " is-off" : ""
                  }`}
                  onClick={() => focusFromGroup(win.hwnd)}
                  onContextMenu={(e) => {
                    // 창 목록에서 바로 그 창의 메뉴(최소화·닫기)를 열 수 있게 한다.
                    e.preventDefault();
                    const shellTop =
                      document.querySelector(".dock-shell")?.getBoundingClientRect().top ?? 0;
                    const rect = e.currentTarget.getBoundingClientRect();
                    openWindowMenu(win, rect.top + rect.height / 2 - shellTop);
                  }}
                >
                  <span className="group-menu-title">{win.title || win.exe}</span>
                  {win.minimized && <span className="group-menu-hint">최소화</span>}
                </button>
              ))}
              {/* 창을 하나씩 열지 않고도 그룹 전체를 다룬다. 레일 알약 클릭과 같은 동작이라
                  문구도 같은 판단(groupFolds)을 따른다. */}
              <div className="window-menu-sep" />
              <button
                type="button"
                className="window-menu-item"
                role="menuitem"
                onClick={() => toggleGroup(cardGroup)}
              >
                {/* 창 하나를 접고 펴는 아이콘과 같은 획을 쓴다 — 같은 동작이기 때문이다. */}
                <svg viewBox="0 0 16 16" aria-hidden>
                  {foldCard ? (
                    <path
                      d="M3.5 8h9"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  ) : (
                    <>
                      <path
                        d="M3.5 6.5h6.5V13H3.5z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M6 3.5h5.5a1 1 0 0 1 1 1V10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </svg>
                {foldCard ? "창 전체 접기" : "창 전체 펴기"}
              </button>
            </div>
          </div>
        )}

        {windowMenu && (
          <div className="menu-slot">
            <div
              ref={menuRef}
              className="window-menu"
              style={{ "--menu-top": `${windowMenu.top}px` } as CSSProperties}
              role="menu"
              aria-label={`${windowMenu.title} 창 메뉴`}
            >
              <div className="window-menu-head">
                {windowMenu.icon && (
                  <img src={windowMenu.icon} alt="" draggable={false} />
                )}
                <span>{windowMenu.title}</span>
              </div>
              <button type="button" className="window-menu-item" role="menuitem" onClick={menuFocus}>
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M3 8h9M9 4.5 12.5 8 9 11.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                창으로 전환
              </button>
              <button
                type="button"
                className="window-menu-item"
                role="menuitem"
                onClick={menuMinimize}
              >
                <svg viewBox="0 0 16 16" aria-hidden>
                  {windowMenu.minimized ? (
                    <path
                      d="M3.5 9.5h9V13h-9z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  ) : (
                    <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  )}
                </svg>
                {windowMenu.minimized ? "창 복원" : "창 최소화"}
              </button>
              {/* 이 창이 여러 창을 가진 앱의 것이면 그룹 전체도 한 번에 다룰 수 있게 한다.
                  레일 알약 클릭이나 창 목록 카드의 같은 항목과 동일한 동작이다. */}
              {menuGroup && (
                <>
                  <div className="window-menu-sep" />
                  <button
                    type="button"
                    className="window-menu-item"
                    role="menuitem"
                    onClick={menuToggleGroup}
                  >
                    {/* 창 하나를 다루는 위 항목과 같은 획을 써서, 범위만 다르다는 것을 보인다. */}
                    <svg viewBox="0 0 16 16" aria-hidden>
                      {foldMenu ? (
                        <path
                          d="M3.5 8h9"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                        />
                      ) : (
                        <>
                          <path
                            d="M3.5 6.5h6.5V13H3.5z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.25"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M6 3.5h5.5a1 1 0 0 1 1 1V10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.25"
                            strokeLinecap="round"
                          />
                        </>
                      )}
                    </svg>
                    {foldMenu
                      ? `창 전체 접기 · ${menuGroup.windows.length}개`
                      : `창 전체 펴기 · ${menuGroup.windows.length}개`}
                  </button>
                </>
              )}
              <div className="window-menu-sep" />
              <button
                type="button"
                className="window-menu-item is-danger"
                role="menuitem"
                onClick={menuClose}
              >
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
                창 닫기
              </button>
            </div>
          </div>
        )}

        {preview && (
          <div className="preview-slot">
            <div
              className="preview-card"
              // 막대에서 카드로 마우스가 건너오는 동안에는 닫지 않는다. 카드 위의
              // 창 버튼을 누르려면 포인터가 이쪽으로 와야 하기 때문이다.
              onMouseEnter={keepPreview}
              onMouseLeave={hidePreview}
              style={{
                // 카드(216px)가 240px 미리보기 칸 안에 들어오도록 위아래를 가둔다.
                top: Math.min(Math.max(preview.top - 106, 8), 24),
              }}
            >
              {previewShot ? (
                <img src={previewShot} alt="" draggable={false} />
              ) : (
                <span className="preview-blank" aria-hidden />
              )}
              <span className="preview-title">
                {preview.icon && (
                  <img className="preview-icon" src={preview.icon} alt="" draggable={false} />
                )}
                <span className="preview-label">{preview.title}</span>
              </span>
              {/* 작업표시줄 미리보기처럼 카드에서 바로 창을 다룬다. hover 중에만
                  드러내지 않고 항상 두어, 누를 수 있다는 것을 바로 알게 한다. */}
              <div className="preview-actions">
                <button
                  type="button"
                  className="preview-action"
                  title="창 최소화"
                  aria-label={`${preview.title} 창 최소화`}
                  onClick={minimizePreviewWindow}
                >
                  <svg viewBox="0 0 12 12" aria-hidden>
                    <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="preview-action is-close"
                  title="창 닫기"
                  aria-label={`${preview.title} 창 닫기`}
                  onClick={closePreviewWindow}
                >
                  <svg viewBox="0 0 12 12" aria-hidden>
                    <path
                      d="M3 3l6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {panelOpen && panelView === "settings" && (
          <SettingsPanel
            pinned={pinned}
            theme={theme}
            shortcut={shortcut}
            maxHeight={dockHeight}
            onBack={() => setPanelView("apps")}
            onMove={movePinned}
            onUnpin={togglePin}
            onTheme={changeTheme}
            onShortcut={changeShortcut}
            onRecordingChange={setRecordingShortcut}
            shape={shape}
            onShape={changeShape}
            side={side}
            onSide={changeSide}
            vertical={vertical}
            onVertical={changeVertical}
            railHeight={railHeight}
            onRailHeight={changeRailHeight}
            autostart={autostart}
            onAutostart={changeAutostart}
            liquid={glassOn}
            facet={shape === "facet"}
          />
        )}
        <Dock
          orientation="vertical"
          apps={apps}
          pinnedPaths={pinnedPaths}
          running={running}
          groups={groups}
          tray={trayApps}
          expanded={menuOpen}
          height={dockHeight}
          railHeight={railHeight}
          stretch={panelOpen && panelView === "settings"}
          side={side}
          query={query}
          onQuery={setQuery}
          onExpand={() => {
            setPanelView("apps");
            setPanelOpen(true);
          }}
          onClose={() => {
            setPanelOpen(false);
            setQuery("");
          }}
          onLaunch={launch}
          onTogglePin={togglePin}
          onFocus={(hwnd) => {
            // 창 전환은 Windows의 포그라운드 제한에 걸릴 수 있다. 조용히 실패하지 않게 남긴다.
            if (isTauri()) focusWindow(hwnd).catch((err) => console.warn("창 전환 실패", err));
            setPanelOpen(false);
          }}
          onHoverWindow={showPreview}
          onHoverGroup={showGroupCard}
          onToggleGroup={toggleGroup}
          onMenuWindow={openWindowMenu}
          onOpenSettings={() => setPanelView("settings")}
          onBackdropDark={setAutoDark}
          liquid={glassOn}
          facet={shape === "facet"}
        />
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  captureWindow,
  focusWindow,
  getConfig,
  launchApp,
  listApps,
  listRunningWindows,
  listTrayApps,
  resizeDock,
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
import { useStableWindows } from "./lib/windows";

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
  const shots = useRef(new Map<number, { at: number; url: string }>());
  const previewHwnd = useRef<number | null>(null);
  const previewTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  // 단축키를 녹음하는 동안에는 전역 단축키 이벤트를 무시한다. 녹음 중에 같은 조합을
  // 누르면 패널이 닫히면서 녹음 자체가 사라지던 문제를 막는다.
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const recordingRef = useRef(recordingShortcut);
  recordingRef.current = recordingShortcut;
  const panelOpenRef = useRef(false);

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
      setWindows(
        DEMO_APPS.slice(0, 3).map((app, i) => ({
          hwnd: 1000 + i,
          title: app.name,
          exe: `C:\\Demo\\${app.name}.exe`,
          icon: app.icon,
          active: i === 0,
          // 데모에서도 최소화된 창 하나를 두어 꺼진 획을 확인할 수 있게 한다.
          minimized: i === 2,
        })),
      );
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
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!win) {
      hidePreview();
      return;
    }
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
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setPreview(null);
      setPreviewShot(null);
    }, 90);
  };

  // 설정 화면이거나 메뉴가 닫혔으면 미리보기를 남기지 않는다.
  // 창 목록에서 창을 골라 패널이 닫히면 줄이 사라져 mouseleave가 오지 않는다.
  useEffect(() => {
    if (panelOpen && panelView === "apps") return;
    previewHwnd.current = null;
    setPreview(null);
    setPreviewShot(null);
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
        {preview && (
          <div className="preview-slot">
            <div
              className="preview-card"
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
            liquid={glassOn}
            facet={shape === "facet"}
          />
        )}
        <Dock
          orientation="vertical"
          apps={apps}
          pinnedPaths={pinnedPaths}
          running={running}
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
          onOpenSettings={() => setPanelView("settings")}
          onBackdropDark={setAutoDark}
          liquid={glassOn}
          facet={shape === "facet"}
        />
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type AppEntry,
  type RunningWindow,
  focusWindow,
  getPinned,
  launchApp,
  listApps,
  listRunningWindows,
  resizeDock,
  setPinned,
} from "./lib/ipc";
import Dock from "./components/Dock";
import LauncherPanel from "./components/LauncherPanel";

// 설치 이름은 기계마다 다르므로 이름으로 찾되, 하나도 못 찾으면 앞에서부터 채운다.
const DEFAULT_PINNED = [
  "Google Chrome",
  "Microsoft Edge",
  "Visual Studio Code",
  "Windows Terminal",
  "Notepad",
];

// 창 안팎의 여백: 터치 영역은 독 본체에만 두되, 그림자가 잘리지 않을 만큼만 남긴다.
const TOP_ROOM = 20;
const BOTTOM_ROOM = 6;
const SIDE_ROOM = 16;
const PANEL_GAP = 10;

// 브라우저에서 열어 스타일만 확인할 때 쓰는 가상 앱. 타우리 밖에서는 진짜 목록이 없다.
const DEMO_ICONS = ["#4f9dff", "#a78bfa", "#f472b6", "#f87171", "#fbbf24", "#34d399"];
const DEMO_APPS: AppEntry[] = ["Chrome", "Code", "Explorer", "Terminal", "Notepad", "Spotify"].map(
  (name, i) => ({
    id: `demo-${i}`,
    name,
    path: "",
    icon: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="14" fill="${DEMO_ICONS[i]}"/><text x="24" y="32" font-size="22" text-anchor="middle" fill="#0b0c10" font-family="sans-serif" font-weight="700">${name[0]}</text></svg>`,
    )}`,
  }),
);

export default function App() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [pinnedPaths, setPinnedPaths] = useState<string[]>([]);
  const [running, setRunning] = useState<RunningWindow[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  const pinned = useMemo(() => {
    const byPath = new Map(apps.map((a) => [a.path, a]));
    return pinnedPaths
      .map((path) => byPath.get(path))
      .filter((app): app is AppEntry => !!app);
  }, [apps, pinnedPaths]);

  useEffect(() => {
    if (!isTauri()) {
      setApps(DEMO_APPS);
      setPinnedPaths(DEMO_APPS.map((a) => a.path));
      setRunning(
        DEMO_APPS.slice(0, 3).map((app, i) => ({
          hwnd: 1000 + i,
          title: app.name,
          icon: app.icon,
        })),
      );
      return;
    }
    let disposed = false;
    (async () => {
      const [all, stored] = await Promise.all([listApps(), getPinned()]);
      if (disposed) return;
      setApps(all);
      let paths = stored;
      if (paths.length === 0) {
        const byName = new Map(all.map((a) => [a.name.toLowerCase(), a]));
        paths = DEFAULT_PINNED.map((name) => byName.get(name.toLowerCase())?.path).filter(
          (path): path is string => !!path,
        );
        if (paths.length === 0) paths = all.slice(0, 6).map((a) => a.path);
        setPinned(paths).catch(() => {});
      }
      setPinnedPaths(paths);
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // 실행 중인 창: 러스트가 목록이 바뀔 때만 알린다. 매초 새로고침하지 않아도 된다.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const refresh = () => {
      listRunningWindows()
        .then((list) => {
          if (!disposed) setRunning(list);
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

  // 창 크기를 내용물에 맞춘다. 실행기 검색어가 바뀔 때마다 높이도 바뀐다.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (!isTauri()) return;
    const raf = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      resizeDock(
        Math.ceil(rect.width) + SIDE_ROOM * 2,
        Math.ceil(rect.height) + TOP_ROOM + BOTTOM_ROOM,
      ).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [apps.length, pinned.length, running.length, panelOpen, query]);

  // 실행기: 패널이 열려 있는 동안만 Esc를 받아 닫는다.
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    const onBlur = () => setPanelOpen(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [panelOpen]);

  const launch = (app: AppEntry) => {
    if (isTauri() && app.path) launchApp(app.path).catch(() => {});
    setPanelOpen(false);
    setQuery("");
  };

  return (
    <div className="fixed inset-x-0 bottom-0 flex justify-center">
      <div
        ref={contentRef}
        className="flex w-fit flex-col items-center"
        style={{ paddingTop: TOP_ROOM, paddingBottom: BOTTOM_ROOM, gap: PANEL_GAP }}
      >
        {panelOpen && (
          <LauncherPanel
            apps={apps}
            query={query}
            onQuery={setQuery}
            onLaunch={launch}
          />
        )}
        <Dock
          items={pinned}
          running={running}
          panelOpen={panelOpen}
          onLaunch={launch}
          onFocus={(hwnd) => {
            if (isTauri()) focusWindow(hwnd).catch(() => {});
            setPanelOpen(false);
          }}
          onTogglePanel={() => {
            setPanelOpen((open) => !open);
            setQuery("");
          }}
        />
      </div>
    </div>
  );
}

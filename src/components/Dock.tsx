import type { AppEntry, RunningWindow } from "../lib/ipc";

type Props = {
  items: AppEntry[];
  running: RunningWindow[];
  panelOpen: boolean;
  onLaunch: (app: AppEntry) => void;
  onFocus: (hwnd: number) => void;
  onTogglePanel: () => void;
};

// 고정한 앱과 실행 중인 창을 한 줄로 나란히 놓는 작업표시줄 대체 독.
// 마우스를 올리면 커지는 장식 없이, 아이콘은 항상 같은 크기다.
export default function Dock({
  items,
  running,
  panelOpen,
  onLaunch,
  onFocus,
  onTogglePanel,
}: Props) {
  return (
    <div className="dock-shell">
      {items.map((app) => (
        <button
          key={app.id}
          className="dock-item"
          onClick={() => onLaunch(app)}
          aria-label={app.name}
        >
          {app.icon ? (
            <img src={app.icon} alt="" draggable={false} className="dock-icon" />
          ) : (
            <span className="dock-fallback">{app.name.slice(0, 1)}</span>
          )}
        </button>
      ))}

      {running.length > 0 && <span className="dock-sep" aria-hidden />}

      {running.map((win) => (
        <button
          key={win.hwnd}
          className="dock-item"
          onClick={() => onFocus(win.hwnd)}
          aria-label={win.title}
        >
          {win.icon ? (
            <img src={win.icon} alt="" draggable={false} className="dock-icon" />
          ) : (
            <span className="dock-fallback">{win.title.slice(0, 1)}</span>
          )}
          <span className="dock-dot" aria-hidden />
        </button>
      ))}

      <span className="dock-sep" aria-hidden />

      <button
        className={`dock-item dock-launcher${panelOpen ? " dock-launcher-on" : ""}`}
        onClick={onTogglePanel}
        aria-label="앱 실행기"
      >
        <svg viewBox="0 0 24 24" className="dock-icon" aria-hidden>
          <g fill="currentColor">
            <rect x="3" y="3" width="7.5" height="7.5" rx="2.4" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="2.4" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="2.4" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.4" />
          </g>
        </svg>
      </button>
    </div>
  );
}

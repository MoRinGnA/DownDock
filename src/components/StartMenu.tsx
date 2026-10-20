import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  powerAction,
  type AppEntry,
  type PowerAction,
  type RunningWindow,
  type Side,
  type SystemStatus,
  type TrayApp,
} from "../lib/ipc";

type Props = {
  apps: AppEntry[];
  pinnedPaths: string[];
  running: RunningWindow[];
  // 최소화가 아니라 트레이에만 남아 있는 프로그램(^ 안의 아이콘).
  tray: TrayApp[];
  // 레일과 같은 볼륨·배터리 값. 숫자가 필요할 때 여기서 확인한다.
  status: SystemStatus | null;
  // 독이 붙은 화면 가장자리. 왼쪽이면 설정·닫기 버튼을 왼쪽 끝에 둔다.
  side: Side;
  query: string;
  onQuery: (query: string) => void;
  onLaunch: (app: AppEntry) => void;
  onFocus: (hwnd: number) => void;
  onTogglePin: (app: AppEntry) => void;
  onOpenSettings: () => void;
  onClose: () => void;
  // 목록의 창 줄에 마우스를 올리면 접힌 레일과 똑같이 미리보기를 띄운다.
  onHoverWindow: (win: RunningWindow | null, top: number) => void;
};

// 전원 동작. 창 목록 아래에 놓는다.
const POWER_ITEMS: { action: PowerAction; label: string; icon: string }[] = [
  { action: "sleep", label: "절전", icon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" },
  {
    action: "logoff",
    label: "로그아웃",
    icon: "M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20H15M10 16l4-4-4-4M14 12H3",
  },
  {
    action: "restart",
    label: "다시 시작",
    icon: "M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4",
  },
  { action: "shutdown", label: "종료", icon: "M12 3v8M7.2 6.6a7.5 7.5 0 1 0 9.6 0" },
];

// 검색 결과 한 줄. 창과 앱을 한 목록에 섞어 놓고 위에서부터 고른다.
type Result = { kind: "window"; win: RunningWindow } | { kind: "app"; app: AppEntry };

// 실행 파일 이름에서 확장자를 떼어 검색어로도 쓰게 한다(C:\…\chrome.exe → chrome).
function exeName(exe: string): string {
  return (exe.split(/[\\/]/).pop() ?? exe).replace(/\.exe$/i, "");
}

// 펼친 레일의 내용. 접힌 레일과 같은 높이를 그대로 쓰고 폭만 넓어진다.
// 검색어가 없으면 지금 열린 창을 보여 주고, 입력하면 창과 앱을 함께 걸러 낸다.
export default function StartMenu({
  apps,
  pinnedPaths,
  running,
  tray,
  status,
  side,
  query,
  onQuery,
  onLaunch,
  onFocus,
  onTogglePin,
  onOpenSettings,
  onClose,
  onHoverWindow,
}: Props) {
  const pinned = useMemo(() => {
    const byPath = new Map(apps.map((app) => [app.path, app]));
    return pinnedPaths.map((path) => byPath.get(path)).filter((app): app is AppEntry => !!app);
  }, [apps, pinnedPaths]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const windows = running
      .filter((win) => !q || `${win.title} ${exeName(win.exe)}`.toLowerCase().includes(q))
      .map((win) => ({ kind: "window" as const, win }));
    // 검색어가 없을 때는 앱을 늘어놓지 않는다. 창 전환이 우선이다.
    if (!q) return windows;
    const found = apps
      .filter((app) => app.name.toLowerCase().includes(q))
      .map((app) => ({ kind: "app" as const, app }));
    return [...windows, ...found];
  }, [apps, running, query]);

  const searching = query.trim().length > 0;

  // 키보드로 고른 줄. 검색어나 창 목록이 바뀌면 처음으로 돌아간다.
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, running.length]);

  const activate = (result: Result | undefined) => {
    if (!result) return;
    if (result.kind === "window") onFocus(result.win.hwnd);
    else onLaunch(result.app);
  };

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 선택된 줄이 목록 밖으로 나가지 않게 따라간다. 섹션이 나뉘어 있어도 찾아간다.
    const row = bodyRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 종료 계열은 두 번 눌러야 실행한다. 실수로 PC가 꺼지는 걸 막는다.
  const [confirming, setConfirming] = useState<PowerAction | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const runPower = (action: PowerAction) => {
    if (action !== "sleep" && confirming !== action) {
      setConfirming(action);
      return;
    }
    setConfirming(null);
    if (isTauri()) powerAction(action).catch(() => {});
  };

  // 줄의 세로 중심을 독 기준 좌표로 바꿔 미리보기를 그 높이에 띄운다(레일과 같은 방식).
  const hoverRow = (element: HTMLElement, win: RunningWindow) => {
    const shellTop = element.closest(".dock-shell")?.getBoundingClientRect().top ?? 0;
    const rect = element.getBoundingClientRect();
    onHoverWindow(win, rect.top + rect.height / 2 - shellTop);
  };

  const windowRow = (win: RunningWindow, index: number) => (
    <button
      key={`w-${win.hwnd}`}
      className={`start-row${active === index ? " is-active" : ""}${
        win.active ? " is-current" : ""
      }`}
      data-row={index}
      onClick={() => onFocus(win.hwnd)}
      onMouseEnter={(e) => {
        setActive(index);
        hoverRow(e.currentTarget, win);
      }}
      onMouseLeave={() => onHoverWindow(null, 0)}
      title={win.title || win.exe}
    >
      {win.icon ? (
        <img src={win.icon} alt="" draggable={false} className="start-row-icon" />
      ) : (
        <span className="start-row-fallback">{(win.title || exeName(win.exe)).slice(0, 1)}</span>
      )}
      <span className="start-row-title">{win.title || exeName(win.exe)}</span>
      <span className="start-row-kind">{exeName(win.exe)}</span>
    </button>
  );

  const appRow = (app: AppEntry, index: number) => (
    <button
      key={`a-${app.path}`}
      className={`start-row${active === index ? " is-active" : ""}`}
      data-row={index}
      onClick={() => onLaunch(app)}
      onMouseEnter={() => setActive(index)}
      title={app.name}
    >
      {app.icon ? (
        <img src={app.icon} alt="" draggable={false} loading="lazy" decoding="async" className="start-row-icon" />
      ) : (
        <span className="start-row-fallback">{app.name.slice(0, 1)}</span>
      )}
      <span className="start-row-title">{app.name}</span>
      <span className="start-row-kind">앱</span>
    </button>
  );

  const tile = (app: AppEntry) => (
    <button
      key={app.path}
      className="launcher-item launcher-item-pinned"
      onClick={() => onLaunch(app)}
      onContextMenu={(e) => {
        e.preventDefault();
        onTogglePin(app);
      }}
      title={`${app.name} — 우클릭으로 고정 해제`}
    >
      {app.icon ? (
        <img
          src={app.icon}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="launcher-icon"
        />
      ) : (
        <span className="launcher-fallback">{app.name.slice(0, 1)}</span>
      )}
      <span>{app.name}</span>
    </button>
  );

  // 레일은 막대 길이로만 보여 주므로, 정확한 값은 여기서 숫자와 막대로 읽는다.
  const batteryPct = status?.battery != null ? Math.round(status.battery) : null;
  const volumePct = status?.volume != null ? Math.round(status.volume) : null;

  return (
    <div className="start-menu">
      <div className={`start-head${side === "left" ? " is-left" : ""}`}>
        <input
          className="launcher-input start-search"
          placeholder="창·앱 검색…"
          value={query}
          autoFocus
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              activate(results[active]);
            }
          }}
        />
        <button className="glass-btn start-icon" onClick={onOpenSettings} aria-label="설정" title="설정">
          {/* 글자 대신 선 아이콘. 좁은 버튼에서 이모지·기호는 흐릿하게 뭉갠다. */}
          <svg viewBox="0 0 24 24" aria-hidden>
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 5.5 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="glass-btn start-icon" onClick={onClose} aria-label="닫기" title="닫기 (Esc)">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path
              d="M6 6l12 12M18 6 6 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* 창 목록과 고정 앱을 한 스크롤 영역에 둔다. 창이 많든 고정 앱이 많든
          잘린 타일 대신 자연스럽게 스크롤된다.
          화면에 떠 있는 창과 최소화된 창을 섹션으로 나눠, 숨은 프로그램도
          한 번에 찾아갈 수 있게 한다. */}
      <div className="start-body" ref={bodyRef}>
        {searching ? (
          <section className="start-section">
            <h2 className="start-label">검색 결과</h2>
            <div className="start-list">
              {results.map((result, i) =>
                result.kind === "window" ? windowRow(result.win, i) : appRow(result.app, i),
              )}
            </div>
            {results.length === 0 && <p className="launcher-empty">찾은 항목이 없습니다.</p>}
          </section>
        ) : (
          <>
            <section className="start-section">
              <h2 className="start-label">지금 열린 창</h2>
              <div className="start-list">
                {running.map((win, i) => windowRow(win, i))}
              </div>
              {running.length === 0 && (
                <p className="launcher-empty">화면에 열린 창이 없습니다.</p>
              )}
            </section>

            {tray.length > 0 && (
              <section className="start-section">
                <h2 className="start-label">
                  숨겨진 프로그램
                  <span className="start-label-count">{tray.length}</span>
                </h2>
                <div className="start-list start-list-tray">
                  {tray.map((app) => (
                    <button
                      key={`t-${app.id}`}
                      className="start-row start-row-tray"
                      onClick={() =>
                        onLaunch({ id: app.id, name: app.name, path: app.exe, icon: app.icon })
                      }
                      title={`${app.name} — 백그라운드에서 실행 중 (트레이)`}
                    >
                      {app.icon ? (
                        <img
                          src={app.icon}
                          alt=""
                          draggable={false}
                          className="start-row-icon"
                        />
                      ) : (
                        <span className="start-row-fallback">{app.name.slice(0, 1)}</span>
                      )}
                      <span className="start-row-title">{app.name}</span>
                      <span className="start-row-kind">트레이</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {pinned.length > 0 && (
              <section className="start-section">
                <h2 className="start-label">고정됨</h2>
                <div className="start-grid">{pinned.map(tile)}</div>
              </section>
            )}
          </>
        )}
      </div>

      {status?.media && (
        <div className="start-media">
          <span className="start-media-art" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path
                d="M9 18V5l10-2v13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="6.6" cy="18" r="2.6" fill="currentColor" />
              <circle cx="16.6" cy="16" r="2.6" fill="currentColor" />
            </svg>
          </span>
          <div className="start-media-copy">
            <span className="start-media-title">{status.media.title}</span>
            {status.media.artist && (
              <span className="start-media-artist">{status.media.artist}</span>
            )}
          </div>
          <span className="start-media-state">
            {status.media.playing ? "재생 중" : "일시정지"}
          </span>
          <span className="start-media-track" aria-hidden>
            <i style={{ width: `${Math.round((status.media.progress ?? 0) * 100)}%` }} />
          </span>
        </div>
      )}

      {/* 배터리·볼륨은 문장이 아니라 아이콘 + 숫자 + 가는 막대로 읽는다. */}
      <div className="start-status">
        <div className="start-status-item">
          <svg viewBox="0 0 24 24" aria-hidden>
            <rect
              x="3"
              y="7.5"
              width="15"
              height="9"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M20.5 10.5v3" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            {batteryPct != null && batteryPct > 0 && (
              <rect
                x="5"
                y="9.5"
                width={Math.max(1, (11 * Math.min(100, batteryPct)) / 100)}
                height="5"
                rx="1"
                fill="currentColor"
              />
            )}
          </svg>
          <span className="start-status-label">배터리</span>
          <span className="start-status-value">
            {batteryPct != null ? `${batteryPct}%` : "—"}
          </span>
          <span className="start-status-bar" aria-hidden>
            <i style={{ width: `${batteryPct ?? 0}%` }} />
          </span>
        </div>
        <div className={`start-status-item${status?.muted ? " is-muted" : ""}`}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path
              d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z"
              fill="currentColor"
              opacity="0.85"
            />
            {!status?.muted && (
              <path
                d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            )}
          </svg>
          <span className="start-status-label">볼륨</span>
          <span className="start-status-value">
            {status?.muted ? "음소거" : volumePct != null ? `${volumePct}%` : "—"}
          </span>
          <span className="start-status-bar" aria-hidden>
            <i style={{ width: `${status?.muted ? 0 : (volumePct ?? 0)}%` }} />
          </span>
        </div>
      </div>

      <div className="launcher-power">
        <div className="launcher-power-row">
          {POWER_ITEMS.map((item) => (
            <button
              key={item.action}
              className={`glass-btn launcher-power-btn${confirming === item.action ? " is-confirming" : ""}`}
              onClick={() => runPower(item.action)}
              aria-label={item.label}
              title={confirming === item.action ? "한 번 더 누르면 실행합니다" : item.label}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path
                  d={item.icon}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="glass-btn-label">{confirming === item.action ? "확인" : item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

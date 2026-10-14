import { useEffect, useMemo, useRef } from "react";
import type { AppEntry } from "../lib/ipc";

type Props = {
  apps: AppEntry[];
  query: string;
  onQuery: (next: string) => void;
  onLaunch: (app: AppEntry) => void;
};

// 시작 메뉴 전체를 유리 패널에 그리는 실행기. 이름이 포함된 앱만 남기고
// 첫 결과는 Enter로 바로 연다.
export default function LauncherPanel({ apps, query, onQuery, onLaunch }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((app) => app.name.toLowerCase().includes(q));
  }, [apps, query]);

  return (
    <div className="launcher-panel">
      <input
        ref={inputRef}
        className="launcher-input"
        placeholder="앱 검색…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && filtered[0]) onLaunch(filtered[0]);
        }}
      />
      <div className="launcher-grid">
        {filtered.map((app) => (
          <button key={app.id} className="launcher-item" onClick={() => onLaunch(app)}>
            {app.icon ? (
              <img src={app.icon} alt="" draggable={false} className="launcher-icon" />
            ) : (
              <span className="launcher-fallback">{app.name.slice(0, 1)}</span>
            )}
            <span>{app.name}</span>
          </button>
        ))}
        {filtered.length === 0 && <p className="launcher-empty">찾은 앱이 없습니다.</p>}
      </div>
    </div>
  );
}

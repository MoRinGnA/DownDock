import { useEffect, useState } from "react";
import type { RunningWindow, SystemStatus } from "../lib/ipc";

type Props = {
  status: SystemStatus | null;
  // 최근 사용한 순서(러스트 EnumWindows의 Z 순서)로 온 실행 중 창.
  running: RunningWindow[];
  // 접힌 레일의 최소 세로 길이. 설정에서 조절한다.
  railHeight: number;
  onFocus: (hwnd: number) => void;
  // 위쪽 손잡이를 누르면 시작 메뉴를 펼친다.
  onExpand: () => void;
  // 미리보기: null이면 숨기고, 숫자는 독 안에서의 세로 위치(px).
  onHoverWindow: (win: RunningWindow | null, top: number) => void;
};

// 레일 막대는 창 개수 표시가 아니라 창 하나당 버튼이다. 누르면 그 창으로 바로 전환한다.
const MAX_TICKS = 24;

export default function InfoRail({
  status,
  running,
  railHeight,
  onFocus,
  onExpand,
  onHoverWindow,
}: Props) {
  // 시계는 분 단위로만 바뀐다. 10초마다 확인해 분이 넘어가면 바로 반영한다.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const clockLabel = now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const volume = status?.volume ?? null;
  const media = status?.media ?? null;
  const battery = status?.battery ?? null;
  const muted = status?.muted ?? false;
  const charging = status?.charging ?? false;
  const windows = running.slice(0, MAX_TICKS);
  // 배터리는 25%짜리 막대 네 개. 켜진 개수로만 읽고, 1~12%에서도 하나는 켠다.
  const batteryBars =
    battery === null ? 0 : Math.min(4, battery > 0 ? Math.max(1, Math.round(battery / 25)) : 0);
  const mediaPct = Math.round((media?.progress ?? 0) * 100);

  return (
    <span className="rail" style={{ minHeight: railHeight }}>
      {/* 위쪽 한 덩이: 펼침 손잡이 · 두 줄 시계 · 실행 중인 창 획. */}
      <span className="rail-top">
        <button
          type="button"
          className="rail-handle"
          title="눌러서 펼치기"
          aria-label="독 펼치기"
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        />
        <time
          className="rail-clock"
          dateTime={`${hours}:${minutes}`}
          title={clockLabel}
          aria-label={clockLabel}
        >
          <span>{hours}</span>
          <span>{minutes}</span>
        </time>
        <span className="rail-windows">
        {windows.map((win) => (
          <button
            key={win.hwnd}
            className={`rail-window${win.active ? " is-active" : ""}${
              win.minimized ? " is-off" : ""
            }`}
            title={`${win.title || win.exe}${
              win.active ? " (지금 보는 창)" : win.minimized ? " (최소화됨)" : ""
            }`}
            aria-label={`${win.title || win.exe}${
              win.minimized ? " (최소화됨)" : ""
            } 창으로 전환`}
            onMouseEnter={(e) => {
              // 막대의 세로 중심을 독 기준 좌표로 바꿔 미리보기를 그 높이에 띄운다.
              const shellTop =
                e.currentTarget.closest(".dock-shell")?.getBoundingClientRect().top ?? 0;
              const rect = e.currentTarget.getBoundingClientRect();
              onHoverWindow(win, rect.top + rect.height / 2 - shellTop);
            }}
            onMouseLeave={() => onHoverWindow(null, 0)}
            onFocus={() => onHoverWindow(win, 0)}
            onBlur={() => onHoverWindow(null, 0)}
            onClick={(e) => {
              // 레일 바탕을 눌렀을 때처럼 펼쳐지면 안 된다.
              e.stopPropagation();
              onFocus(win.hwnd);
            }}
          />
        ))}
        </span>
      </span>

      {/* 재생 중인 곡: 제목과 진행 바를 번갈아 보여 준다. 한 자리에 하나만 두어
          좁은 폭에서도 '미디어'라는 맥락이 흐려지지 않게 한다. */}
      {media && (
        <span
          className={`rail-media${media.playing ? " is-playing" : ""}`}
          title={`${media.title}${media.artist ? ` — ${media.artist}` : ""}${
            media.progress != null ? ` · ${mediaPct}%` : ""
          }`}
          role="img"
          aria-label={`${media.playing ? "재생 중" : "일시정지"}: ${media.title}${
            media.artist ? ` — ${media.artist}` : ""
          }`}
        >
          <svg className="rail-media-note" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M6 12V3.2l7-1.4v8.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            <circle cx="4.2" cy="12.2" r="2.2" fill="currentColor" />
            <circle cx="11.2" cy="10.8" r="2.2" fill="currentColor" />
          </svg>
          <span className="rail-media-swap">
            <span className="rail-media-title">{media.title}</span>
            <span className="rail-media-progress" aria-hidden>
              <span className="rail-media-track">
                <i style={{ width: `${mediaPct}%` }} />
              </span>
            </span>
          </span>
        </span>
      )}

      {/* 볼륨은 스피커 아이콘으로 용도를 밝히고, 아래에 세로 게이지를 둔다. */}
      {volume !== null && (
        <span
          className={`rail-volume${muted ? " is-muted" : ""}`}
          title={`볼륨 ${Math.round(volume)}%${muted ? " (음소거)" : ""}`}
          role="img"
          aria-label={`볼륨 ${Math.round(volume)}%${muted ? " (음소거)" : ""}`}
        >
          <svg className="rail-volume-icon" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M2.8 6.2h2.4L8.4 3.4v9.2L5.2 9.8H2.8z"
              fill="currentColor"
              opacity="0.85"
            />
            <path
              d="M10.6 6.2a2.6 2.6 0 0 1 0 3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          <span className="rail-gauge" aria-hidden>
            <i style={{ height: `${volume}%` }} />
          </span>
        </span>
      )}

      {/* 배터리: 25%짜리 직사각형 막대 네 개. 위의 작은 돌기는 배터리임을 알린다. */}
      {battery !== null && (
        <span
          className={`rail-battery${charging ? " is-charging" : ""}`}
          role="img"
          aria-label={`배터리 ${Math.round(battery)}%${charging ? " · 충전 중" : ""}`}
          title={`배터리 ${Math.round(battery)}%${charging ? " · 충전 중" : ""}`}
        >
          {/* 충전 중에는 뚜껑 대신 작은 번개를 세운다. 색 없이도 상태가 바로 읽힌다. */}
          {charging ? (
            <svg className="rail-battery-bolt" viewBox="0 0 8 10" aria-hidden>
              <path d="M4.6 0 0.8 5.4h2.4L2.4 10l4.8-6.1H4.4z" fill="currentColor" />
            </svg>
          ) : (
            <span className="rail-battery-cap" aria-hidden />
          )}
          {[0, 1, 2, 3].map((segment) => (
            <i key={segment} className={segment < batteryBars ? "is-lit" : undefined} />
          ))}
        </span>
      )}
    </span>
  );
}

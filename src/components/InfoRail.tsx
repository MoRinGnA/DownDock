import { useEffect, useState } from "react";
import type { RunningWindow, SystemStatus } from "../lib/ipc";
import { groupFolds, type WindowGroup } from "../lib/windows";

type Props = {
  status: SystemStatus | null;
  // 같은 앱의 창을 하나로 묶은 목록. 창 목록과 같은 순서를 따른다.
  groups: WindowGroup[];
  // 접힌 레일의 최소 세로 길이. 설정에서 조절한다.
  railHeight: number;
  onFocus: (hwnd: number) => void;
  // 위쪽 손잡이를 누르면 시작 메뉴를 펼친다.
  onExpand: () => void;
  // 미리보기: null이면 숨기고, 숫자는 독 안에서의 세로 위치(px).
  onHoverWindow: (win: RunningWindow | null, top: number) => void;
  // 창이 여러 개인 앱: 대표 창 대신 창 목록을 띄운다.
  onHoverGroup: (group: WindowGroup, top: number) => void;
  // 창이 여러 개인 앱의 막대를 누르면 그 앱의 창 전체를 접거나 판다.
  onToggleGroup: (group: WindowGroup) => void;
  // 우클릭 메뉴. 위치는 미리보기와 같은 방식으로 계산한다.
  onMenuWindow: (win: RunningWindow, top: number) => void;
};

// 막대는 창이 아니라 앱 하나당 하나다. 창이 하나면 그 창으로 전환하고,
// 여러 개면 작업표시줄처럼 그 앱의 창을 통째로 접거나 판다.
const MAX_TICKS = 24;

export default function InfoRail({
  status,
  groups,
  railHeight,
  onFocus,
  onExpand,
  onHoverWindow,
  onHoverGroup,
  onToggleGroup,
  onMenuWindow,
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
  const shown = groups.slice(0, MAX_TICKS);
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
        {shown.map((group) => {
          const lead = group.lead;
          const count = group.windows.length;
          // 같은 앱의 창이 여러 개면 막대 하나가 그 앱을 나타낸다. 누르면 그 앱의 창을
          // 통째로 접고 펴며, 올리면 창 목록을 띄워 어느 창으로 갈지 고르게 한다.
          const hint = count > 1 ? ` · 창 ${count}개` : "";
          const state = group.active
            ? " (지금 보는 창)"
            : group.minimized
              ? count > 1
                ? " (모두 최소화됨)"
                : " (최소화됨)"
              : "";
          const action =
            count > 1 ? (groupFolds(group) ? "창 전체 접기" : "창 전체 펴기") : "창으로 전환";
          return (
            <button
              key={group.key}
              className={`rail-window${group.active ? " is-active" : ""}${
                group.minimized ? " is-off" : ""
              }`}
              title={`${group.name}${hint}${state} — ${action}`}
              aria-label={`${group.name}${hint}${state} — ${action}`}
              onMouseEnter={(e) => {
                // 막대의 세로 중심을 독 기준 좌표로 바꿔 카드를 그 높이에 띄운다.
                const shellTop =
                  e.currentTarget.closest(".dock-shell")?.getBoundingClientRect().top ?? 0;
                const rect = e.currentTarget.getBoundingClientRect();
                const top = rect.top + rect.height / 2 - shellTop;
                if (count > 1) onHoverGroup(group, top);
                else onHoverWindow(lead, top);
              }}
              onMouseLeave={() => onHoverWindow(null, 0)}
              onContextMenu={(e) => {
                // 브라우저 기본 메뉴 대신 대표 창의 메뉴를 띄운다.
                e.preventDefault();
                const shellTop =
                  e.currentTarget.closest(".dock-shell")?.getBoundingClientRect().top ?? 0;
                const rect = e.currentTarget.getBoundingClientRect();
                onMenuWindow(lead, rect.top + rect.height / 2 - shellTop);
              }}
              onFocus={() => {
                if (count > 1) onHoverGroup(group, 0);
                else onHoverWindow(lead, 0);
              }}
              onBlur={() => onHoverWindow(null, 0)}
              onClick={(e) => {
                // 레일 바탕을 눌렀을 때처럼 펼쳐지면 안 된다.
                e.stopPropagation();
                // 창이 여러 개면 작업표시줄처럼 그룹 전체를 접고 펀다.
                if (count > 1) onToggleGroup(group);
                else onFocus(lead.hwnd);
              }}
            />
          );
        })}
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

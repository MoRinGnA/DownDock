import { useRef } from "react";
import type { AppEntry, RunningWindow, Side, TrayApp } from "../lib/ipc";
import { useSystemStatus } from "../lib/useSystemStatus";
import { glassStyle, useDesktopBackdrop, useLiquidGlass, useLiveGlass } from "../lib/liquidGlass";
import GlassFilter from "./GlassFilter";
import InfoRail from "./InfoRail";
import StartMenu from "./StartMenu";

type Props = {
  apps: AppEntry[];
  pinnedPaths: string[];
  running: RunningWindow[];
  // 화면에 창 없이 트레이에만 남은 프로그램.
  tray: TrayApp[];
  // true면 시작 메뉴, false면 접힌 대기 레일. 레일은 내용 높이에 맞춰 줄어든다.
  expanded: boolean;
  // 펼친 패널의 표면 높이(px). Rust가 정한 화면 최대 높이에서 여백을 뺀 값.
  height: number;
  // 접힌 레일의 세로 길이(px). 설정에서 조절한다.
  railHeight: number;
  // 옆에 설정 패널이 떠 있을 때 레일도 패널 높이만큼 늘려 두 표면의 위아래를 맞춘다.
  stretch: boolean;
  // 독이 붙은 가장자리. 시작 메뉴 머리의 버튼 위치를 뒤집는다.
  side: Side;
  orientation: "vertical";
  query: string;
  onQuery: (query: string) => void;
  onExpand: () => void;
  onClose: () => void;
  onLaunch: (app: AppEntry) => void;
  onTogglePin: (app: AppEntry) => void;
  onFocus: (hwnd: number) => void;
  // 레일 막대에 마우스를 올리면 그 창의 미리보기를 요청한다.
  onHoverWindow: (win: RunningWindow | null, top: number) => void;
  onOpenSettings: () => void;
  // 자동 테마: 독 뒤 배경 평균 밝기가 어두워졌는지 알린다.
  onBackdropDark: (dark: boolean) => void;
  liquid: boolean;
  // 각진 유리: 모서리를 45도로 깎는다.
  facet: boolean;
};

// 화면 가장자리 아래에 떠 있는 세로 패널.
// 평소에는 23px 캡슐 레일로 필요한 정보만 보여 주고, 누르면 시작 메뉴로 펼쳐진다.
export default function Dock({
  apps,
  pinnedPaths,
  running,
  tray,
  expanded,
  height,
  railHeight,
  stretch,
  side,
  orientation,
  query,
  onQuery,
  onExpand,
  onClose,
  onLaunch,
  onFocus,
  onHoverWindow,
  onTogglePin,
  onOpenSettings,
  onBackdropDark,
  liquid,
  facet,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const glassCanvas = useRef<HTMLCanvasElement>(null);
  // 사각 모드에서는 굴절 거리장도 반지름 0으로 그려야 모서리에 둥근 띠가 남지 않는다.
  const radius = facet ? 0 : expanded ? 26 : 12;
  const bezel = expanded ? 26 : 12;
  const glass = useLiquidGlass(shellRef, { radius, bezel, enabled: liquid });
  const { style: liveStyle, live } = useLiveGlass(
    shellRef,
    glassCanvas,
    liquid,
    // 펼친 패널은 굴절이 끝(테두리)에만 남도록 흐림을 키우고 채도를 낮춘다.
    // 바탕화면 색이 그대로 올라오면 목록 글자가 묻힌다.
    {
      radius,
      bezel,
      scale: expanded ? 24 : 18,
      blur: expanded ? 9 : 3,
      saturation: expanded ? 1.05 : 1.45,
    },
    onBackdropDark,
  );
  // 복제(DDA)가 안 되면 1fps GDI 스냅숏으로 폴백한다.
  const backdrop = useDesktopBackdrop(shellRef, liquid && !live);
  // 볼륨·배터리는 워커가 밀어 준다. 레일과 패널이 같은 값을 함께 쓴다.
  const status = useSystemStatus();

  return (
    <>
      <GlassFilter id="lg-dock" maps={glass} scale={expanded ? 26 : 18} />
      <div
        ref={shellRef}
        className={`dock-shell dock-shell-${orientation} ${
          expanded ? "dock-shell-menu" : "dock-shell-collapsed"
        }${stretch ? " dock-shell-beside-panel" : ""}`}
        // 펼친 뒤에는 포인터가 벗어나도 접지 않는다. 닫기는 Esc·바깥 클릭(창 포커스 상실)·✕로만 한다.
        // 레일 안에는 창 전환 버튼이 따로 있으므로 바탕을 눌렀을 때만 펼친다.
        onClick={expanded ? undefined : onExpand}
        role={expanded ? "dialog" : undefined}
        aria-label={expanded ? "시작 메뉴" : undefined}
        style={{
          // 접힌 레일은 내용 높이에 맞춘다. 빈 공간만큼 창이 커지면 클릭을 가로챈다.
          height: expanded ? height : "auto",
          ...glassStyle(glass, "lg-dock"),
          ...backdrop,
          ...liveStyle,
        }}
      >
        <canvas ref={glassCanvas} className="glass-canvas" aria-hidden />
        {expanded ? (
          <StartMenu
            apps={apps}
            pinnedPaths={pinnedPaths}
            running={running}
            tray={tray}
            status={status}
            side={side}
            query={query}
            onQuery={onQuery}
            onLaunch={onLaunch}
            onFocus={onFocus}
            onTogglePin={onTogglePin}
            onOpenSettings={onOpenSettings}
            onClose={onClose}
            onHoverWindow={onHoverWindow}
          />
        ) : (
          <InfoRail
            status={status}
            running={running}
            railHeight={railHeight}
            onFocus={onFocus}
            onExpand={onExpand}
            onHoverWindow={onHoverWindow}
          />
        )}
      </div>
    </>
  );
}

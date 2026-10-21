import { invoke } from "@tauri-apps/api/core";

export type AppEntry = {
  id: string;
  name: string;
  path: string;
  icon: string | null;
};

export type RunningWindow = {
  hwnd: number;
  title: string;
  /** 실행 파일 전체 경로. 고정 아이콘과 실행 중 창을 같은 앱으로 묶는 데 쓴다. */
  exe: string;
  icon: string | null;
  /** 지금 보고 있는 창. 순서를 바꾸는 대신 이 값으로만 표시한다. */
  active: boolean;
  /** 최소화되어 화면에 떠 있지 않은 창. 레일에서는 꺼진 획으로 보인다. */
  minimized: boolean;
};

export const listApps = () => invoke<AppEntry[]>("list_apps");

export const launchApp = (path: string) => invoke<void>("launch_app", { path });

export const getPinned = () => invoke<string[]>("get_pinned");

export const setPinned = (paths: string[]) => invoke<void>("set_pinned", { paths });

// auto: 독 뒤 배경 밝기에 맞춰 light/dark를 고른다.
export type Theme = "system" | "light" | "dark" | "auto";

// round: 둥근 유리 | facet: 모서리를 45도로 깎은 각진 유리
export type Shape = "round" | "facet";

// 독이 붙는 화면 가장자리. 오른쪽은 창 스크롤바를 가리므로 왼쪽이 기본.
export type Side = "left" | "right";

// 화면에서 독이 놓이는 세로 위치.
export type Vertical = "top" | "center" | "bottom";

export type AppConfig = {
  pinned: string[];
  theme: Theme;
  shortcut: string;
  shape: Shape;
  side: Side;
  vertical: Vertical;
  // 접힌 레일의 세로 길이(px). 창이 많으면 이 값보다 길어진다.
  railHeight: number;
  // 로그온할 때 자동으로 뜰지(마지막으로 성공한 설정). 실제 등록 상태는 getAutostart로 읽는다.
  autostart: boolean;
};

export const getConfig = () => invoke<AppConfig>("get_config");export const saveTheme = (theme: Theme) => invoke<void>("set_theme", { theme });
export const saveShape = (shape: Shape) => invoke<void>("set_shape", { shape });
export const saveSide = (side: Side) => invoke<void>("set_side", { side });
export const saveVertical = (vertical: Vertical) =>
  invoke<void>("set_vertical", { vertical });
export const saveRailHeight = (height: number) =>
  invoke<void>("set_rail_height", { height });

// 로그온 자동 시작. OS에 실제로 등록된 상태를 돌려주므로 UI는 이 값을 그대로 쓴다.
export const getAutostart = () => invoke<boolean>("get_autostart");
export const saveAutostart = (enabled: boolean) =>
  invoke<boolean>("set_autostart", { enabled });

// 실패하면 이유가 담긴 문자열로 거부된다(예: 다른 프로그램이 이미 쓰는 키).
export const saveShortcut = (combo: string) => invoke<void>("set_shortcut", { combo });

// 창을 프런트엔드가 그린 내용물 크기에 맞춘다. 창이 내용물보다 크면
// 보이지 않는 여백이 바탕화면의 클릭을 가로챈다.
// Rust 명령은 side·align 인자를 필수로 받는다. 빠지면 호출이 실패해 창이 기본 80px에 머문다.
// align: "bottom"은 접힌 레일을 화면 아래에, "center"는 펼친 패널을 가운데 둔다.
export type DockAlign = Vertical;
export const resizeDock = (width: number, height: number, side: Side, align: DockAlign) =>
  invoke<number>("resize_dock", { width, height, side, align });

export const listRunningWindows = () => invoke<RunningWindow[]>("list_running_windows");

// 작업표시줄 ^ 안에만 남아 있는 프로그램(최소화가 아니라 백그라운드 트레이 앱).
export type TrayApp = {
  id: string;
  name: string;
  exe: string;
  icon: string | null;
};

export const listTrayApps = () => invoke<TrayApp[]>("list_tray_apps");

// 지금 재생 중인 미디어(SMTC). 재생 중인 세션이 없으면 null.
export type MediaInfo = {
  title: string;
  artist: string;
  playing: boolean;
  /** 재생 위치 0~1. 길이를 모르는 스트림은 null. */
  progress: number | null;
};

// 접힌 레일이 보여 주는 값. 배터리가 없는 데스크톱에서는 battery가 null이다.
export type SystemStatus = {
  volume: number | null;
  muted: boolean;
  battery: number | null;
  charging: boolean;
  media: MediaInfo | null;
};

export const getSystemStatus = () => invoke<SystemStatus>("system_status");

export const focusWindow = (hwnd: number) => invoke<void>("focus_window", { hwnd });

// 같은 앱의 창 전체를 접거나 되살린다. 작업표시줄 그룹 버튼과 같은 동작이다.
// 되살릴 때는 focus 창을 마지막에 올려 그 창이 맨 위에 남는다.
export const minimizeWindows = (hwnds: number[]) =>
  invoke<void>("minimize_windows", { hwnds });
export const restoreWindows = (hwnds: number[], focus: number) =>
  invoke<void>("restore_windows", { hwnds, focus });

// 메뉴·창 목록에서 "그 창으로 가라"를 뜻한다. 이미 그 창을 보고 있어도 최소화하지 않는다.
export const activateWindow = (hwnd: number) => invoke<void>("activate_window", { hwnd });

// 미리보기 카드의 창 버튼. 닫기는 WM_CLOSE를 보내므로 저장 확인은 그 앱이 띄운다.
export const closeWindow = (hwnd: number) => invoke<void>("close_window", { hwnd });
export const minimizeWindow = (hwnd: number) => invoke<void>("minimize_window", { hwnd });

// 창 하나를 축소 캡처해 data URL(BMP)로 돌려준다. 화면에 가려져 있어도 내용이 나온다.
export const captureWindow = (hwnd: number, maxWidth = 300) =>
  invoke<string>("capture_window", { hwnd, maxWidth });

// 종료·다시 시작·절전·로그아웃. Rust가 허용한 동작만 실행한다.
export type PowerAction = "shutdown" | "restart" | "sleep" | "logoff";

export const powerAction = (action: PowerAction) =>
  invoke<void>("power_action", { action });

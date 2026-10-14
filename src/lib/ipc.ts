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
  icon: string | null;
};

export const listApps = () => invoke<AppEntry[]>("list_apps");

export const launchApp = (path: string) => invoke<void>("launch_app", { path });

export const getPinned = () => invoke<string[]>("get_pinned");

export const setPinned = (paths: string[]) => invoke<void>("set_pinned", { paths });

// 창을 프런트엔드가 그린 내용물 크기에 맞춘다. 창이 내용물보다 크면
// 보이지 않는 여백이 바탕화면의 클릭을 가로챈다.
export const resizeDock = (width: number, height: number) =>
  invoke<void>("resize_dock", { width, height });

export const listRunningWindows = () => invoke<RunningWindow[]>("list_running_windows");

export const focusWindow = (hwnd: number) => invoke<void>("focus_window", { hwnd });

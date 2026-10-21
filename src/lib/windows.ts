import { useMemo, useRef } from "react";
import type { RunningWindow } from "./ipc";

// 창은 열린 순서를 기억한다. 활성화될 때마다 순서가 바뀌면 어느 막대가 어느 창인지
// 알 수 없으므로, 새 창만 뒤에 붙이고 닫힌 창만 뺀다.
export function useStableWindows(running: RunningWindow[]): RunningWindow[] {
  const orderRef = useRef<number[]>([]);
  return useMemo(() => {
    const byHwnd = new Map(running.map((win) => [win.hwnd, win]));
    const kept = orderRef.current.filter((hwnd) => byHwnd.has(hwnd));
    const seen = new Set(kept);
    const added = running.map((win) => win.hwnd).filter((hwnd) => !seen.has(hwnd));
    orderRef.current = [...kept, ...added];
    return orderRef.current.map((hwnd) => byHwnd.get(hwnd)!);
  }, [running]);
}

// 실행 파일 경로에서 앱 이름을 얻는다. 창 제목은 페이지 제목이라 앱을 알려 주지 않는다.
export function appNameOf(exe: string): string {
  return (exe.split(/[\\/]/).pop() ?? exe).replace(/\.exe$/i, "");
}

/// 독의 한 칸이 나타내는 앱. 작업표시줄처럼 같은 실행 파일의 창을 하나로 묶는다.
export type WindowGroup = {
  key: string;
  exe: string;
  name: string;
  icon: string | null;
  windows: RunningWindow[];
  // 대표 창: 포커스된 창이 있으면 그 창, 없으면 가장 먼저 열린 창.
  lead: RunningWindow;
  // 대표 창이 지금 전경(사용자가 보는 창)인가. 접힌 창은 여기에 세지 않는다.
  active: boolean;
  // 모든 창이 최소화됐는가(레일에서 꺼진 획).
  minimized: boolean;
};

// 입력 순서를 그대로 지킨다. 창 목록이 이미 고정 순서이므로, 새 앱은 뒤에만 붙고
// 포커스가 바뀌어도 칸이 흔들리지 않는다.
export function groupWindows(running: RunningWindow[]): WindowGroup[] {
  const groups = new Map<string, WindowGroup>();
  for (const win of running) {
    const key = win.exe.toLowerCase();
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        key,
        exe: win.exe,
        name: appNameOf(win.exe),
        icon: win.icon,
        windows: [win],
        lead: win,
        active: win.active,
        minimized: win.minimized,
      });
      continue;
    }
    group.windows.push(win);
    group.active = group.active || win.active;
    group.minimized = group.minimized && win.minimized;
    if (win.active) group.lead = win;
    if (!group.icon) group.icon = win.icon;
  }
  return [...groups.values()];
}

// 그룹 알약을 지금 누르면 접기가 되는가, 펴기가 되는가 — 작업표시줄과 같은 규칙이다.
// 그 앱을 쓰고 있으면 접기, 아니면 펴기. 활성 표시는 1.2초마다 오는 목록을 따르므로,
// 그 사이에 창이 접혔을 수 있어 지금 상태로 다시 판단한다(전부 접혀 있으면 펴기).
// 레일 툴팁·메뉴 문구·실제 클릭이 모두 이 판단을 함께 쓴다.
export function groupFolds(group: WindowGroup): boolean {
  return group.active && group.windows.some((win) => !win.minimized);
}

// 같은 앱은 항상 같은 색이 나오도록 실행 파일 이름에서 색을 고른다.
// 임의 각도 대신 손으로 고른 색상환을 쓰는 이유: 비슷한 이름에서 색이 뭉치면
// (Chrome·Code·Explorer가 모두 청목색이 되는 식) 구분이 안 된다.
const HUES = [205, 262, 328, 8, 42, 96, 158, 186];

export function hueOf(exe: string): number {
  // FNV-1a. 짧은 문자열에서도 자릿수가 고르게 퍼진다.
  let hash = 0x811c9dc5;
  const key = exe.toLowerCase();
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return HUES[(hash >>> 0) % HUES.length];
}

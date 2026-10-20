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

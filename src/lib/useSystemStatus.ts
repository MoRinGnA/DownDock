import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSystemStatus, type SystemStatus } from "./ipc";

// 브라우저에서 스타일만 확인할 때 쓰는 값. 타우리 밖에서는 실제 장치가 없다.
const DEMO_STATUS: SystemStatus = {
  volume: 62,
  muted: false,
  battery: 78,
  charging: false,
  media: { title: "Dynamite", artist: "BTS", playing: true, progress: 0.42 },
};

// 볼륨·배터리는 러스트 워커가 바뀔 때마다 밀어 준다(볼륨 100ms). 처음 한 번만 직접 묻는다.
export function useSystemStatus(): SystemStatus | null {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setStatus(DEMO_STATUS);
      return;
    }
    let disposed = false;
    getSystemStatus()
      .then((initial) => {
        if (!disposed) setStatus(initial);
      })
      .catch(() => {});
    const unlisten = listen<SystemStatus>("system:status", (event) => {
      if (!disposed) setStatus(event.payload);
    });
    return () => {
      disposed = true;
      unlisten.then((off) => off());
    };
  }, []);

  return status;
}

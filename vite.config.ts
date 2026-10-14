import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 타우리는 devUrl 포트가 고정이어야 한다. strictPort로 충돌을 숨기지 않고 드러낸다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // localhost는 ::1로 풀려 IPv6 전용으로 묶이는 수가 있다. 루프백을 못 박는다.
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    sourcemap: false,
  },
});

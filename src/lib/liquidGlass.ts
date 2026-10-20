import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  createGlassRenderer,
  drawGlass,
  uploadFrame,
  type GlassUniforms,
} from "./glassShader";
import { invoke, isTauri } from "@tauri-apps/api/core";

// 리퀴드 글래스 표면. 둥근 사각형의 거리장(SDF)을 WebGL 프래그먼트 셰이더로 계산해
// 가장자리에서 배경을 끌어당기는 변위 맵을 만든다 (SVG feDisplacementMap이 소비).
// WebGL을 쓸 수 없으면 null을 돌려주고, 호출부는 기존 블러 스타일을 그대로 쓴다.

export type GlassMaps = { displacement: string };

const VERTEX_SHADER = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uSize;    // 표면 크기 (CSS px)
uniform float uDpr;    // 캔버스 픽셀 / CSS px
uniform float uRadius; // 모서리 반지름 (CSS px). 0이면 사각
uniform float uBezel;  // 굴절이 일어나는 가장자리 두께 (CSS px)

// 안쪽이 음수, 바깥이 양수인 표면 거리장. glassShader와 같은 식을 쓴다.
float sdShape(vec2 p) {
  vec2 hs = uSize * 0.5;
  vec2 q = abs(p - hs) - hs + vec2(uRadius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
}

void main() {
  // 캔버스는 위가 0이므로 y를 뒤집어 CSS 좌표(위가 0)로 맞춘다.
  vec2 p = vec2(gl_FragCoord.x / uDpr, uSize.y - gl_FragCoord.y / uDpr);
  float sd = sdShape(p);
  float inside = 1.0 - step(0.0, sd);
  // 0 = 가장자리, 1 = bezel 안쪽 끝
  float depth = clamp(-sd / uBezel, 0.0, 1.0);
  // 가장자리 곡률이 완만하게 떨어지도록 지수를 낮춘다 (넓은 굴절 띠).
  float rim = pow(1.0 - depth, 1.6) * inside;
  // 안쪽 전체를 살짝 오목하게 당기는 렌즈 확대 성분. 크면 표면이 흔들려 보인다.
  float lens = (1.0 - depth) * 0.1 * inside;

  // 바깥 방향 법선 = 거리장의 기울기
  float e = 0.5;
  vec2 grad = vec2(
    sdShape(p + vec2(e, 0.0)) - sdShape(p - vec2(e, 0.0)),
    sdShape(p + vec2(0.0, e)) - sdShape(p - vec2(0.0, e))
  );
  vec2 n = normalize(grad + vec2(1e-6));

  // 가장자리일수록 안쪽 배경을 당겨 와서 볼록한 유리처럼 굴절시킨다.
  vec2 disp = -n * clamp(rim + lens, 0.0, 1.0);
  gl_FragColor = vec4(0.5 + 0.5 * disp.x, 0.5 + 0.5 * disp.y, 0.5, 1.0);
}
`;

type UniformName = "uSize" | "uDpr" | "uRadius" | "uBezel";
const UNIFORM_NAMES: UniformName[] = ["uSize", "uDpr", "uRadius", "uBezel"];

type Renderer = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  uniforms: Record<UniformName, WebGLUniformLocation | null>;
};

let renderer: Renderer | null | undefined;

function createRenderer(): Renderer | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    premultipliedAlpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("셰이더를 만들 수 없습니다");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "셰이더 컴파일 실패");
    }
    return shader;
  };

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "프로그램 링크 실패");
  }
  gl.useProgram(program);

  // 화면 전체를 덮는 사각형 하나
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uniforms = Object.fromEntries(
    UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Record<UniformName, WebGLUniformLocation | null>;

  return { canvas, gl, uniforms };
}

function getRenderer(): Renderer | null {
  if (renderer === undefined) {
    try {
      renderer = createRenderer();
    } catch {
      renderer = null;
    }
  }
  return renderer;
}

function drawMap(
  r: Renderer,
  width: number,
  height: number,
  radius: number,
  bezel: number,
  dpr: number,
): string {
  const { canvas, gl, uniforms: u } = r;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(u.uSize, width, height);
  gl.uniform1f(u.uDpr, dpr);
  gl.uniform1f(u.uRadius, radius);
  gl.uniform1f(u.uBezel, bezel);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas.toDataURL("image/png");
}

export type GlassOptions = {
  /** 모서리 반지름. 0이면 사각 표면. */
  radius: number;
  bezel: number;
  enabled: boolean;
};

// 표면 크기가 바뀔 때마다 맵을 다시 그린다. 사용할 수 없으면 null.
export function useLiquidGlass<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { radius, bezel, enabled }: GlassOptions,
): GlassMaps | null {
  const [maps, setMaps] = useState<GlassMaps | null>(null);

  useEffect(() => {
    const el = ref.current;
    const r = enabled && el ? getRenderer() : null;
    if (!el || !r) {
      setMaps(null);
      return;
    }
    let raf = 0;
    const update = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width < 1 || height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      setMaps({ displacement: drawMap(r, width, height, radius, bezel, dpr) });
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    });
    observer.observe(el);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, radius, bezel, enabled]);

  return maps;
}

// backdrop_frame 응답 헤더: gen(8) + width(4) + height(4) + luminance(4).
const HEADER_LEN = 20;

// 굴절 필터가 가장자리에서 당겨 올 픽셀이 필요하므로 표면보다 이만큼 넓게 캡처한다.
// 캡처 이미지는 표면 밖으로 이만큼 삐져나와 깔리고, 표면의 overflow가 잘라낸다.
const BACKDROP_MARGIN = 16;

// 투명 창에서는 backdrop-filter가 바탕화면을 볼 수 없어서, 표면 뒤 화면을 주기적으로
// 캡처해 굴절 필터가 걸릴 배경으로 쓴다. 러스트가 넘긴 사각형만 정확히 잘라 주므로
// 결과 이미지는 캡처한 크기에 그대로 늘려 깔면 된다 — DPI 배율이나 창 위치를 계산하지 않는다.
export function useDesktopBackdrop(ref: RefObject<HTMLElement | null>, enabled: boolean): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || !isTauri()) {
      setStyle({});
      return;
    }
    let disposed = false;
    let current: string | null = null;
    let busy = false;

    const capture = async () => {
      if (busy || disposed) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      busy = true;
      try {
        // 화면 끝에 붙은 독은 바깥쪽에 캡처할 픽셀이 없다. 창 안쪽으로만 넓혀
        // 음수 좌표를 찍지 않게 한다(왼쪽 가장자리에서 검은 띠가 생기던 원인).
        const left = Math.max(0, rect.left - BACKDROP_MARGIN);
        const top = Math.max(0, rect.top - BACKDROP_MARGIN);
        const right = Math.min(window.innerWidth, rect.right + BACKDROP_MARGIN);
        const bottom = Math.min(window.innerHeight, rect.bottom + BACKDROP_MARGIN);
        if (right - left < 1 || bottom - top < 1) return;
        const buf = await invoke<ArrayBuffer>("capture_backdrop", {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        });
        if (disposed) return;
        const next = URL.createObjectURL(new Blob([buf], { type: "image/bmp" }));
        const prev = current;
        current = next;
        setStyle({
          "--glass-backdrop": `url(${next})`,
          "--glass-tint-color": "var(--glass-tint)",
          "--glass-ring": "1",
          // 캡처 이미지를 표면 밖으로 늘릴 여백(top/right/bottom/left).
          "--backdrop-inset": `${top - rect.top}px ${rect.right - right}px ${bottom - rect.bottom}px ${left - rect.left}px`,
        } as CSSProperties);
        // 이전 URL은 React가 새 값을 그린 뒤에 버린다.
        if (prev) window.setTimeout(() => URL.revokeObjectURL(prev), 1000);
      } catch (err) {
        // 캡처 실패 시 배경 없이 기본 블러로 둔다.
        console.warn("표면 배경 캡처에 실패했습니다", err);
      } finally {
        busy = false;
      }
    };

    capture();
    // 창이 바탕화면 위에서 움직이거나 다른 창이 그 위를 덮으므로 계속 새로 찍는다.
    const timer = window.setInterval(capture, 1000);
    const observer = new ResizeObserver(capture);
    observer.observe(el);
    window.addEventListener("resize", capture);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      observer.disconnect();
      window.removeEventListener("resize", capture);
      if (current) URL.revokeObjectURL(current);
    };
  }, [ref, enabled]);

  return style;
}

// 데스크톱 복제(DXGI Desktop Duplication)로 받은 프레임을 캔버스에 그린다.
// GDI 스냅숏(useDesktopBackdrop)과 달리 화면 주사율대로 갱신되며, 화면이 그대로면
// 새 프레임이 오지 않아 비용이 들지 않는다. 복제를 못 만들면 live=false로 남아 GDI로 폴백한다.
export function useLiveGlass(
  surfaceRef: RefObject<HTMLElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
  params: GlassUniforms,
  // 배경이 어두워지면 true. 매 프레임 부르지 않도록 상태가 바뀔 때만 알린다.
  onDarkChange?: (dark: boolean) => void,
): { style: CSSProperties; live: boolean } {
  const [live, setLive] = useState(false);
  const onDarkRef = useRef(onDarkChange);
  onDarkRef.current = onDarkChange;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const style = useMemo<CSSProperties>(
    () =>
      enabled
        ? ({
            // 캔버스가 배경을 그리므로 무거운 backdrop-filter는 끈다.
            // (WebGL 맵을 못 만들어도 34px 블러가 배경을 뿌옇게 덮지 않는다)
            "--glass-base": "none",
            "--glass-tint-color": "var(--glass-tint)",
            "--glass-ring": "1",
            // 실시간 캔버스가 굴절을 직접 그리므로 ::before의 SVG 필터는 끈다.
            // 매 프레임 큰 사각형에 필터를 한 번 더 먹이면 시작 메뉴가 끊긴다.
            ...(live ? { "--glass-filter": "none" } : {}),
          } as CSSProperties)
        : {},
    [enabled, live],
  );

  useEffect(() => {
    const el = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!enabled || !el || !canvas || !isTauri()) {
      setLive(false);
      return;
    }
    let renderer: ReturnType<typeof createGlassRenderer>;
    try {
      renderer = createGlassRenderer(canvas);
    } catch (err) {
      // 셰이더를 못 만들면 GDI 스냅숏 폴백이 그대로 동작한다.
      console.warn("유리 셰이더를 만들지 못했습니다", err);
      return;
    }
    if (!renderer) return;

    // 표면 크기(기기 픽셀)에 맞춰 굴절을 다시 그린다.
    const draw = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      drawGlass(
        renderer,
        canvas,
        { width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 },
        paramsRef.current,
        // 캡처는 창 전체 한 장이다. 표면은 그 안에서 자기 위치만 샘플링한다.
        { x: rect.left, y: rect.top, width: window.innerWidth, height: window.innerHeight },
      );
    };

    // 첫 프레임이 오기 전에는 검은 텍스처가 보이지 않게 감춘다.
    canvas.style.opacity = "0";

    let disposed = false;
    let gen = 0;
    let raf = 0;
    let busy = false;
    let regionKey = "";
    let smoothed = -1;
    let dark = false;
    let pendingSince = 0;

    // 독과 패널이 동시에 떠 있으면 각자 자기 사각형을 요청하게 되고, 캡처 영역이
    // 프레임마다 서로를 덮어써 엉뚱한 배경(다른 표면 자리의 픽셀)이 그려진다.
    // 창 전체를 한 번만 찍고 표면마다 그 안의 위치를 샘플링하면 이 경합이 사라진다.
    const syncRegion = async () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const key = `${width}x${height}`;
      if (key === regionKey) return;
      regionKey = key;
      gen = 0;
      await invoke("set_backdrop_region", { x: 0, y: 0, width, height });
    };

    const tick = async () => {
      if (disposed) return;
      await syncRegion();
      if (disposed) return;
      // 새 프레임이 없으면 빈 버퍼가 온다.
      const buf = await invoke<ArrayBuffer>("backdrop_frame", { since: gen });
      if (disposed || !buf || buf.byteLength < 16) return;
      const view = new DataView(buf);
      const nextGen = Number(view.getBigUint64(0, true));
      const width = view.getUint32(8, true);
      const height = view.getUint32(12, true);
      if (width < 1 || height < 1) return;
      uploadFrame(renderer, new Uint8Array(buf, HEADER_LEN), width, height);
      draw();
      canvas.style.opacity = "1";
      gen = nextGen;
      setLive(true);

      // 평균 밝기로 테마를 고른다. 새 프레임 쪽에 더 무게를 두고(0.45),
      // 유지 시간도 0.18초로 줄여 배경이 바뀌면 바로 따라간다. 히스테리시스는
      // 남겨 두어 창이 지나가거나 커서가 깜박일 때 테마가 덜컥 바뀌지 않게 한다.
      const luminance = view.getUint32(16, true);
      smoothed = smoothed < 0 ? luminance : smoothed * 0.55 + luminance * 0.45;
      const wantDark = dark ? smoothed < 124 : smoothed < 108;
      if (wantDark !== dark) {
        if (pendingSince === 0) {
          pendingSince = performance.now();
        } else if (performance.now() - pendingSince > 180) {
          dark = wantDark;
          pendingSince = 0;
          onDarkRef.current?.(dark);
        }
      } else {
        pendingSince = 0;
      }
    };

    // setInterval(33ms)는 주사율과 어긋나 프레임 간격이 들쭉날쭉했다. 화면 주사율에
    // 맞춰 rAF로 돌리고, IPC 응답을 기다리는 동안은 다음 요청을 보내지 않는다.
    const loop = () => {
      raf = requestAnimationFrame(async () => {
        if (disposed) return;
        if (!busy) {
          busy = true;
          try {
            await tick();
          } catch {
            // 복제를 만들 수 없으면 계속 빈 채로 두고 GDI 폴백이 동작한다.
          } finally {
            busy = false;
          }
        }
        if (!disposed) loop();
      });
    };
    draw();
    loop();
    // 새 프레임 없이 크기만 바뀌어도 다시 그려야 한다.
    const observer = new ResizeObserver(() => draw());
    observer.observe(el);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.style.opacity = "";
    };
  }, [surfaceRef, canvasRef, enabled]);

  return { style, live };
}

// 표면에 붙일 CSS 변수. 맵이 없으면 빈 객체라서 CSS의 기본 블러가 쓰인다.
export function glassStyle(maps: GlassMaps | null, filterId: string): CSSProperties {
  if (!maps) return {};
  // 기본 블러는 끄고, 캔버스에 걸리는 SVG 굴절 필터가 그 역할을 대신한다.
  return {
    "--glass-base": "none",
    "--glass-filter": `url(#${filterId})`,
  } as CSSProperties;
}

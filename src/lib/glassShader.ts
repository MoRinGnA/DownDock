// 유리 표면을 WebGL로 직접 그린다. SVG 필터(filter: url(#...))는 크로미움에서 CSS 해상도로
// 래스터화된 뒤 화면 배율만큼 늘어나 뿌옇게 보이는 문제가 있어, 굴절 계산을 프래그먼트
// 셰이더로 옮겼다. 캔버스는 기기 픽셀 크기로 그리므로 배율과 무관하게 선명하다.

const VERTEX_SHADER = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uScene;  // 캡처한 바탕화면 (위→아래 RGBA)
uniform vec2 uSize;        // 표면 크기 (CSS px)
uniform float uRadius;     // 모서리 반지름 (CSS px). 0이면 사각
uniform float uBezel;      // 굴절이 일어나는 가장자리 띠 두께 (CSS px)
uniform float uScale;      // 가장자리에서 당겨 오는 최대 거리 (CSS px)
uniform float uBlur;       // 배경 흐림 반경 (CSS px)
uniform float uSaturation; // 배경 채도 배수
// 캡처 이미지 안에서 이 표면의 좌상단 위치와 캡처 이미지 크기 (모두 CSS px).
// 독과 패널이 한 장의 캡처를 나눠 쓰므로 표면마다 다른 위치를 샘플링한다.
uniform vec2 uSceneOrigin;
uniform vec2 uSceneSize;

vec3 sampleScene(vec2 uv) {
  vec3 c = texture2D(uScene, uv).rgb;
  if (uBlur <= 0.0) return c;
  // 13탭 블러 — 두 고리로 나눠 반경이 커져도 성긴 얼룩(고스팅)이 보이지 않는다.
  // 반지름이 작을 땐 유리 두께감만 주고, 클 땐 뒤 배경을 부드럽게 뭉갠다.
  vec2 t = uBlur / max(uSceneSize, vec2(1.0));
  vec3 sum = c * 0.26;
  vec2 x1 = vec2(t.x, 0.0);
  vec2 y1 = vec2(0.0, t.y);
  sum += (texture2D(uScene, uv + x1 * 0.6).rgb + texture2D(uScene, uv - x1 * 0.6).rgb) * 0.08;
  sum += (texture2D(uScene, uv + y1 * 0.6).rgb + texture2D(uScene, uv - y1 * 0.6).rgb) * 0.08;
  sum += (texture2D(uScene, uv + t * 0.424).rgb + texture2D(uScene, uv - t * 0.424).rgb) * 0.06;
  sum += (texture2D(uScene, uv + t * vec2(0.424, -0.424)).rgb + texture2D(uScene, uv + t * vec2(-0.424, 0.424)).rgb) * 0.06;
  sum += (texture2D(uScene, uv + x1).rgb + texture2D(uScene, uv - x1).rgb) * 0.045;
  sum += (texture2D(uScene, uv + y1).rgb + texture2D(uScene, uv - y1).rgb) * 0.045;
  return sum;
}

// 안쪽이 음수, 바깥이 양수인 표면 거리장. uRadius가 0이면 날카로운 사각이다.
float sdShape(vec2 p) {
  vec2 hs = uSize * 0.5;
  vec2 q = abs(p - hs) - hs + vec2(uRadius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
}

void main() {
  // 화면 좌표(위가 0, y 아래로 증가)로 바꾼다.
  vec2 p = vec2(vUV.x * uSize.x, (1.0 - vUV.y) * uSize.y);
  float sd = sdShape(p);
  // 둥근 모서리 밖도 비우지 않는다. 비우면 가장자리에 요소 배경이 1px 비쳐 흰 선처럼 보이고,
  // 모서리도 계단이 진다. 캔버스 자체가 표면의 border-radius로 잘리므로 그대로 칠한다.
  float inside = 1.0 - step(0.0, sd);

  // 0 = 가장자리, 1 = bezel 안쪽 끝
  float depth = clamp(-sd / max(uBezel, 1.0), 0.0, 1.0);
  float rim = pow(1.0 - depth, 1.6) * inside;

  // 바깥 방향 법선 = 거리장의 기울기
  float e = 0.75;
  vec2 grad = vec2(
    sdShape(p + vec2(e, 0.0)) - sdShape(p - vec2(e, 0.0)),
    sdShape(p + vec2(0.0, e)) - sdShape(p - vec2(0.0, e))
  );
  vec2 n = normalize(grad + vec2(1e-6));

  // 가장자리일수록 안쪽 배경을 당겨 와 볼록한 유리처럼 휜다. 가운데는 변위가 없다.
  vec2 disp = -n * rim * uScale;
  // 표면 좌표 → 캡처 이미지 좌표. 캡처 버퍼의 첫 행이 화면 위쪽이므로 그대로 매핑한다
  // (텍스처에서 v=0이 첫 행이다). p는 이미 위가 0인 좌표라 추가로 뒤집지 않는다.
  vec2 scene = p + uSceneOrigin;
  vec2 sceneUV = scene / max(uSceneSize, vec2(1.0));
  vec2 uv = sceneUV + disp / max(uSceneSize, vec2(1.0));
  vec3 c = sampleScene(clamp(uv, 0.0, 1.0));
  // 레퍼런스의 saturate(var(--saturation))
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);
  gl_FragColor = vec4(c, 1.0);
}
`;

export type GlassUniforms = {
  /** 모서리 반지름. 0이면 사각 표면. */
  radius: number;
  bezel: number;
  scale: number;
  blur: number;
  saturation: number;
};

type Renderer = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("셰이더를 만들 수 없습니다");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "셰이더 컴파일 실패";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

/** 캔버스에 WebGL 유리 렌더러를 붙인다. 실패하면 null. */
export function createGlassRenderer(canvas: HTMLCanvasElement): Renderer | null {
  // 표면 전체를 칠하고 모서리는 CSS가 자르므로 알파 채널은 쓰지 않는다.
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;

  {
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "프로그램 링크 실패");
    }
    gl.useProgram(program);

    // 화면 전체를 덮는 사각형
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 첫 프레임이 오기 전까지 검은 1×1 텍스처로 채워 둔다.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );

    const uniforms = Object.fromEntries(
      [
        "uScene",
        "uSize",
        "uRadius",
        "uBezel",
        "uScale",
        "uBlur",
        "uSaturation",
        "uSceneOrigin",
        "uSceneSize",
      ].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );

    return { gl, program, texture, uniforms };
  }
}

/** 캡처 프레임을 텍스처로 올린다. */
export function uploadFrame(
  r: Renderer,
  rgba: Uint8Array,
  width: number,
  height: number,
): void {
  const { gl } = r;
  gl.bindTexture(gl.TEXTURE_2D, r.texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    rgba,
  );
}

/** 캡처 이미지 안에서 표면이 차지하는 사각형(뷰포트 기준 CSS px). */
export type SceneRect = { x: number; y: number; width: number; height: number };

/** 표면 사각형(device px)에 맞춰 굴절을 그린다. scene을 생략하면 표면 전체를 쓴다. */
export function drawGlass(
  r: Renderer,
  canvas: HTMLCanvasElement,
  size: { width: number; height: number; dpr: number },
  params: GlassUniforms,
  scene?: SceneRect,
): void {
  const { gl, uniforms } = r;
  const width = Math.max(1, Math.round(size.width * size.dpr));
  const height = Math.max(1, Math.round(size.height * size.dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(r.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, r.texture);
  gl.uniform1i(uniforms.uScene, 0);
  gl.uniform2f(uniforms.uSize, Math.max(1, size.width), Math.max(1, size.height));
  gl.uniform1f(uniforms.uRadius, params.radius);
  gl.uniform1f(uniforms.uBezel, params.bezel);
  gl.uniform1f(uniforms.uScale, params.scale);
  gl.uniform1f(uniforms.uBlur, params.blur);
  gl.uniform1f(uniforms.uSaturation, params.saturation);
  const originX = scene?.x ?? 0;
  const originY = scene?.y ?? 0;
  gl.uniform2f(uniforms.uSceneOrigin, originX, originY);
  gl.uniform2f(
    uniforms.uSceneSize,
    Math.max(1, scene?.width ?? size.width),
    Math.max(1, scene?.height ?? size.height),
  );
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}


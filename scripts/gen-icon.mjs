// DownDock 앱 아이콘을 코드로 그려 assets/icon.png로 낸다.
// 타우리 CLI가 이 파일에서 플랫폼별 아이콘을 뽑아 간다.
//   node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const SIZE = 1024;
const RADIUS = 232;

const px = new Float64Array(SIZE * SIZE * 4); // premultiplied-free RGBA, 0..1

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (edge, x) => clamp(0.5 - x / edge, 0, 1);

function roundedBoxCoverage(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r);
  const qy = Math.abs(y) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const outside = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
  return 1 - smooth(1.6, outside);
}

const CX = SIZE / 2;
const CY = SIZE / 2;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const body = roundedBoxCoverage(x - CX + 0.5, y - CY + 0.5, SIZE / 2, SIZE / 2, RADIUS);
    if (body <= 0) continue;

    // 세로로 흐르는 배경 그라데이션 + 상단 은은한 광
    const t = y / SIZE;
    let r = 0.145 + (0.038 - 0.145) * t;
    let g = 0.156 + (0.043 - 0.156) * t;
    let b = 0.188 + (0.058 - 0.188) * t;

    const sheen = Math.exp(-(((x - CX) / (SIZE * 0.42)) ** 2 + ((y - SIZE * 0.1) / (SIZE * 0.16)) ** 2));
    r += sheen * 0.1;
    g += sheen * 0.105;
    b += sheen * 0.115;

    // 아래 화살표 (막대 + 삼각 머리 + 받침대)
    // smooth(1.6, d): d는 경계까지의 부호 거리(안쪽은 음수) → 안쪽이 1, 바깥이 0.
    const ax = x - CX + 0.5;
    const ay = y;
    let ink = 0;

    const stemTop = SIZE * 0.24;
    const stemBottom = SIZE * 0.55;
    const stemHalf = SIZE * 0.045;
    ink = Math.max(
      ink,
      smooth(1.6, Math.abs(ax) - stemHalf) *
        smooth(1.6, Math.max(stemTop - ay, ay - stemBottom)),
    );

    const headTop = SIZE * 0.5;
    const headBottom = SIZE * 0.72;
    const headGrow = clamp((ay - headTop) / (headBottom - headTop), 0, 1);
    ink = Math.max(
      ink,
      smooth(1.6, Math.abs(ax) - SIZE * 0.14 * headGrow) *
        smooth(1.6, Math.max(headTop - ay, ay - headBottom)),
    );

    const barTop = SIZE * 0.775;
    const barBottom = SIZE * 0.825;
    ink = Math.max(
      ink,
      roundedBoxCoverage(
        ax,
        ay - (barTop + barBottom) / 2,
        SIZE * 0.2,
        (barBottom - barTop) / 2,
        SIZE * 0.025,
      ),
    );

    r = r + (0.98 - r) * ink;
    g = g + (0.98 - g) * ink;
    b = b + (0.99 - b) * ink;

    const i = (y * SIZE + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = body;
  }
}

// ---- PNG 인코딩 (필터 0, 단일 IDAT) ----
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const o = rowStart + 1 + x * 4;
    raw[o] = Math.round(clamp(px[i], 0, 1) * 255);
    raw[o + 1] = Math.round(clamp(px[i + 1], 0, 1) * 255);
    raw[o + 2] = Math.round(clamp(px[i + 2], 0, 1) * 255);
    raw[o + 3] = Math.round(clamp(px[i + 3], 0, 1) * 255);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("assets", { recursive: true });
writeFileSync("assets/icon.png", png);
console.log(`assets/icon.png written (${png.length} bytes)`);

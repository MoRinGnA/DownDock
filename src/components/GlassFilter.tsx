import type { GlassMaps } from "../lib/liquidGlass";

type Props = { id: string; maps: GlassMaps | null; scale: number; blur?: number };

// 유리 표면에 거는 굴절 필터. 변위 맵으로 가장자리만 휘게 만들어 가운데는 맑게 둔다
// (레퍼런스의 backdrop-filter: blur(0) + filter: url(#...) 와 같은 구성).
// blur를 주면 패널처럼 넓은 표면을 살짝 흐리게 만든다.
export default function GlassFilter({ id, maps, scale, blur = 0 }: Props) {
  if (!maps) return null;
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }}>
      <defs>
        <filter id={id} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
          <feImage href={maps.displacement} preserveAspectRatio="none" result="map" />
          {blur > 0 && (
            <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
          )}
          <feDisplacementMap
            in={blur > 0 ? "soft" : "SourceGraphic"}
            in2="map"
            scale={scale}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}

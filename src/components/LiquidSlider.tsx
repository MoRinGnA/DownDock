import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

type Props = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  format?: (value: number) => string;
};

// 레퍼런스(liquid toggle)의 손잡이를 그대로 옮긴 슬라이더.
// 트랙은 유리 테두리 안에 액체가 차 있고, 손잡이는 평소 흰 유리다.
// 끄는 동안 손잡이가 액체 색으로 번지며 가로로 늘어나 액체와 한 덩이가 된다.
export default function LiquidSlider({ value, min, max, step, onChange, label, format }: Props) {
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const text = format ? format(value) : String(value);

  // 0~1 비율을 슬라이더의 값으로 바꾼다. 단계에 맞춰 반올림한다.
  const commit = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const raw = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const stepped = Math.round((min + raw * (max - min) - min) / step) * step + min;
    onChange(Math.min(max, Math.max(min, stepped)));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // 트랙을 누른 자리로 바로 이동시킨다. 브라우저 기본 드래그·선택은 막는다.
    e.preventDefault();
    e.currentTarget.focus();
    // 합성 이벤트(테스트)에서는 캡처할 포인터가 없을 수 있다. 실패해도 드래그는 계속한다.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer */
    }
    setDragging(true);
    commit(e.clientX);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    commit(e.clientX);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* no active pointer */
    }
    setDragging(false);
  };

  // 창 크기가 바뀌어도 손잡이는 CSS 비율(--ratio)을 따르므로 따로 계산하지 않는다.
  // 다만 포커스가 빠져나가면 드래그 상태가 남지 않도록 정리한다.
  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = value;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step;
    else if (e.key === "PageDown") next = value - step * 5;
    else if (e.key === "PageUp") next = value + step * 5;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <div
      className="liquid-slider"
      data-dragging={dragging ? "true" : undefined}
      style={{ "--ratio": String(ratio) } as CSSProperties}
    >
      {/* 레퍼런스의 goo 필터: 끄는 동안 액체와 손잡이가 한 덩이로 번진다. */}
      <svg className="liquid-slider__defs" aria-hidden focusable="false">
        <defs>
          <filter id="liquid-slider-goo" x="-20%" y="-80%" width="140%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9"
              result="goo"
            />
          </filter>
        </defs>
      </svg>
      <div
        ref={trackRef}
        className="liquid-slider__track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => setDragging(false)}
        onKeyDown={onKeyDown}
      >
        <span className="liquid-slider__liquid" aria-hidden>
          <span className="liquid-slider__fill" />
          <span className="liquid-slider__knob" />
        </span>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AppEntry, Shape, Side, Theme, Vertical } from "../lib/ipc";
import { glassStyle, useDesktopBackdrop, useLiquidGlass, useLiveGlass } from "../lib/liquidGlass";
import GlassFilter from "./GlassFilter";
import LiquidSlider from "./LiquidSlider";

type Props = {
  pinned: AppEntry[];
  theme: Theme;
  shortcut: string;
  maxHeight: number;
  onBack: () => void;
  onMove: (app: AppEntry, delta: -1 | 1) => void;
  onUnpin: (app: AppEntry) => void;
  onTheme: (theme: Theme) => void;
  onShortcut: (combo: string) => Promise<void>;
  // 녹음 중에는 전역 단축키 토글을 무시해야 한다(App이 처리).
  onRecordingChange: (recording: boolean) => void;
  shape: Shape;
  onShape: (shape: Shape) => void;
  side: Side;
  onSide: (side: Side) => void;
  vertical: Vertical;
  onVertical: (vertical: Vertical) => void;
  railHeight: number;
  onRailHeight: (height: number) => void;
  autostart: boolean;
  onAutostart: (enabled: boolean) => void;
  liquid: boolean;
  facet: boolean;
};

// 스위처가 늘어선 순서가 그대로 막대의 이동 순서다. 아이콘은 24px 뷰박스 선 그림.
const THEME_OPTIONS: { value: Theme; label: string; icon: string }[] = [
  {
    value: "system",
    label: "시스템",
    icon: "M3 5h18v11H3zM8 20h8M12 16v4",
  },
  {
    value: "light",
    label: "라이트",
    icon: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4",
  },
  {
    value: "dark",
    label: "다크",
    icon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  },
  {
    value: "auto",
    label: "자동",
    icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3v18",
  },
];

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

// KeyboardEvent.code를 전역 단축키 키 이름으로 바꾼다. 지원하지 않는 키는 null.
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === "Space") return "Space";
  return null;
}

const SHAPE_OPTIONS: SwitchOption<Shape>[] = [
  {
    value: "round",
    label: "둥근",
    icon: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  },
  { value: "facet", label: "각진", icon: "M8 4h8l4 4v8l-4 4H8l-4-4V8Z" },
];

// 독이 붙을 가장자리. 화살표가 화면 끝을 가리킨다.
const SIDE_OPTIONS: SwitchOption<Side>[] = [
  { value: "left", label: "왼쪽", icon: "M20 12H6M11 6l-6 6 6 6" },
  { value: "right", label: "오른쪽", icon: "M4 12h14M13 6l6 6-6 6" },
];

// 화면에서 독이 놓이는 세로 위치. 위/가운데/아래를 화면 가장자리 선으로 보여 준다.
const VERTICAL_OPTIONS: SwitchOption<Vertical>[] = [
  { value: "top", label: "위", icon: "M5 4h14M12 8v12M8 12l4-4 4 4" },
  { value: "center", label: "가운데", icon: "M5 4h14M5 20h14M12 9v6" },
  { value: "bottom", label: "아래", icon: "M5 20h14M12 4v12M8 12l4 4 4-4" },
];

type SwitchOption<T extends string> = { value: T; label: string; icon: string };

// 로그온 자동 시작. 두 칸짜리 스위처라 지금 상태가 한눈에 보인다.
const AUTOSTART_OPTIONS: SwitchOption<"on" | "off">[] = [
  { value: "on", label: "켬", icon: "M5 12.5l4.5 4.5L19 7" },
  { value: "off", label: "끔", icon: "M6 6l12 12M18 6 6 18" },
];

// 설정 분류. 위 탭으로 갈아 끼우며 한 번에 한 분류만 보여 준다.
type SettingsTab = "pins" | "look" | "keys" | "system";
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "pins", label: "고정 앱" },
  { id: "look", label: "화면" },
  { id: "keys", label: "단축키" },
  { id: "system", label: "동작" },
];

// 가로로 늘어선 선택지 위를 유리 막대가 미끄러지는 스위처.
// 선택이 바뀌는 렌더에서 방향을 바로 계산해야 막대의 이동과 늘어나는 기준점이
// 같은 프레임에 걸린다(파생값으로 두면 재렌더 때 방향이 되돌아간다).
function Switcher<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: SwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const selected = Math.max(
    0,
    options.findIndex((opt) => opt.value === value),
  );
  const [previous, setPrevious] = useState(selected);
  const [direction, setDirection] = useState<"left" | "right">("right");
  if (previous !== selected) {
    setDirection(selected > previous ? "right" : "left");
    setPrevious(selected);
  }

  return (
    <div
      className="settings-switch"
      role="radiogroup"
      aria-label={label}
      data-idx={selected}
      data-dir={direction}
      style={
        { "--idx": String(selected), "--steps": String(options.length) } as CSSProperties
      }
    >
      {options.map((opt) => (
        <label key={opt.value} className="settings-switch__option" title={opt.label}>
          <input
            type="radio"
            name={name}
            className="settings-switch__input"
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <svg viewBox="0 0 24 24" className="settings-switch__icon" aria-hidden>
            <path
              d={opt.icon}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="settings-switch__text">{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// 고정 목록 편집, 테마·모양, 전역 단축키를 한 곳에서 다룬다. 실행기 패널 안에서 열린다.
export default function SettingsPanel({
  pinned,
  theme,
  shortcut,
  maxHeight,
  onBack,
  onMove,
  onUnpin,
  onTheme,
  onShortcut,
  onRecordingChange,
  shape,
  onShape,
  side,
  onSide,
  vertical,
  onVertical,
  railHeight,
  onRailHeight,
  autostart,
  onAutostart,
  liquid,
  facet,
}: Props) {
  const [recording, setRecording] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("pins");
  const [error, setError] = useState<string | null>(null);
  // 등록에 성공한 조합. 실패와 성공이 똑같이 보이지 않도록 따로 알린다.
  const [saved, setSaved] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const glassCanvas = useRef<HTMLCanvasElement>(null);
  // CSS 패널 모서리(26px)와 일치시켜야 베벨 하이라이트가 테두리에 붙는다.
  const radius = facet ? 0 : 26;
  const glass = useLiquidGlass(panelRef, { radius, bezel: 28, enabled: liquid });
  // 실행기와 같은 실시간 굴절. 복제를 못 만들면 GDI 스냅숏으로 폴백한다.
  const { style: liveStyle, live } = useLiveGlass(panelRef, glassCanvas, liquid, {
    radius,
    bezel: 28,
    scale: 26,
    blur: 7,
    saturation: 1.4,
  });
  const backdrop = useDesktopBackdrop(panelRef, liquid && !live);

  // 단축키를 녹화하는 동안에는 Esc·방향키 등이 패널 닫기 같은 동작으로 새지 않도록 캡처 단계에서 받는다.
  useEffect(() => {
    onRecordingChange(recording);
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setError(null);
        return;
      }
      if (MODIFIER_CODES.has(e.code)) return;
      const keyName = keyFromCode(e.code);
      if (!keyName) {
        setError("이 키는 단축키로 쓸 수 없습니다.");
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      if (mods.length === 0) {
        setError("Ctrl, Alt, Shift, Win 중 하나와 함께 누르세요.");
        return;
      }
      setRecording(false);
      const combo = [...mods, keyName].join("+");
      onShortcut(combo)
        .then(() => {
          setError(null);
          setSaved(combo);
        })
        .catch((err) => {
          setSaved(null);
          // invoke가 문자열을 그대로 거부하므로 앞의 "Error: " 같은 접두사는 떼어 낸다.
          setError(String(err).replace(/^Error:\s*/, ""));
        });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      onRecordingChange(false);
    };
  }, [recording, onShortcut, onRecordingChange]);

  return (
    <div
      ref={panelRef}
      className="launcher-panel launcher-panel-side settings-panel"
      style={{ maxHeight, ...glassStyle(glass, "lg-panel"), ...backdrop, ...liveStyle }}
    >
      <GlassFilter id="lg-panel" maps={glass} scale={26} blur={2} />
      <canvas ref={glassCanvas} className="glass-canvas" aria-hidden />
      <div className="settings-header">
        <button
          className="glass-btn settings-back"
          onClick={onBack}
          aria-label="실행기로 돌아가기"
        >
          <span className="glass-btn-label">←</span>
        </button>
        <h2 className="settings-title">설정</h2>
      </div>

      <div className="settings-tabs" role="tablist" aria-label="설정 분류">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`settings-tab${tab === item.id ? " is-active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="settings-tabpane" role="tabpanel" key={tab}>
        {tab === "pins" && (
      <section className="settings-section">
        <h3 className="settings-label">고정한 앱</h3>
        {pinned.length === 0 && (
          <p className="launcher-empty">고정한 앱이 없습니다. 실행기에서 앱을 우클릭해 고정하세요.</p>
        )}
        <ul className="settings-pins">
          {pinned.map((app, i) => (
            <li key={app.path} className="settings-pin">
              <span className="settings-pin-name">{app.name}</span>
              <button
                className="glass-btn settings-icon-btn"
                disabled={i === 0}
                onClick={() => onMove(app, -1)}
                aria-label={`${app.name} 앞으로`}
              >
                <span className="glass-btn-label">↑</span>
              </button>
              <button
                className="glass-btn settings-icon-btn"
                disabled={i === pinned.length - 1}
                onClick={() => onMove(app, 1)}
                aria-label={`${app.name} 뒤로`}
              >
                <span className="glass-btn-label">↓</span>
              </button>
              <button
                className="glass-btn settings-icon-btn"
                onClick={() => onUnpin(app)}
                aria-label={`${app.name} 고정 해제`}
              >
                <span className="glass-btn-label">✕</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
        )}

        {tab === "look" && (
          <>
      <section className="settings-section">
        <h3 className="settings-label">테마</h3>
        <Switcher name="theme" label="테마" options={THEME_OPTIONS} value={theme} onChange={onTheme} />
      </section>

      <section className="settings-section">
        <h3 className="settings-label">표면 모양</h3>
        <Switcher
          name="shape"
          label="표면 모양"
          options={SHAPE_OPTIONS}
          value={shape}
          onChange={onShape}
        />
      </section>

      <section className="settings-section">
        <h3 className="settings-label">화면 가장자리</h3>
        <Switcher name="side" label="화면 가장자리" options={SIDE_OPTIONS} value={side} onChange={onSide} />
      </section>

      <section className="settings-section">
        <h3 className="settings-label">세로 위치</h3>
        <Switcher
          name="vertical"
          label="세로 위치"
          options={VERTICAL_OPTIONS}
          value={vertical}
          onChange={onVertical}
        />
      </section>

      <section className="settings-section">
        <h3 className="settings-label">독 길이</h3>
        <div className="settings-range-row">
          <LiquidSlider
            value={railHeight}
            min={260}
            max={760}
            step={10}
            onChange={onRailHeight}
            label="접힌 독의 세로 길이"
            format={(v) => `${v}px`}
          />
          <span className="settings-range-value">{railHeight}px</span>
        </div>
        <p className="settings-hint">창이 많아지면 이 길이보다 더 길어집니다.</p>
      </section>

          </>
        )}

        {tab === "keys" && (
      <section className="settings-section">
        <h3 className="settings-label">전역 단축키</h3>
        <div className="settings-shortcut">
          <kbd className="settings-kbd">{recording ? "키를 누르세요…" : shortcut}</kbd>
          {recording ? (
            <button className="glass-btn settings-text-btn" onClick={() => setRecording(false)}>
              <span className="glass-btn-label">취소</span>
            </button>
          ) : (
            <button
              className="glass-btn settings-text-btn"
              onClick={() => {
                setError(null);
                setSaved(null);
                setRecording(true);
              }}
            >
              <span className="glass-btn-label">변경</span>
            </button>
          )}
        </div>
        <p className={`settings-hint${saved ? " settings-hint-ok" : ""}`}>
          {error ??
            (saved
              ? `${saved} 로 등록했습니다. 어디서든 이 키로 메뉴가 열리고 닫힙니다.`
              : "어디서든 이 키를 누르면 메뉴가 열리고 닫힙니다. Esc로 취소합니다.")          }
        </p>
      </section>
        )}

        {tab === "system" && (
      <section className="settings-section">
        <h3 className="settings-label">시작</h3>
        <Switcher
          name="autostart"
          label="로그온할 때 자동 시작"
          options={AUTOSTART_OPTIONS}
          value={autostart ? "on" : "off"}
          onChange={(value) => onAutostart(value === "on")}
        />
        <p className="settings-hint">
          켜면 Windows에 로그온할 때 DownDock이 함께 떠 작업표시줄을 대신할 준비를 마칩니다.
          끄면 다음 로그온부터 뜨지 않고, 지금 실행 중인 독은 그대로 남습니다.
        </p>
      </section>
        )}
      </div>
    </div>
  );
}

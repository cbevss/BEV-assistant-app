import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LAYER_EVENT, bubbleSpot, toLayer, type CursorState, type LayerMessage, type Mark, type Pt, type Tone } from "./types";

const TONES: Record<Tone, string> = { accent: "78 205 222", good: "34 197 94", warn: "245 158 11", bad: "239 68 68" };
const rgb = (t: Tone | undefined, a = 1) => `rgb(${TONES[t ?? "accent"]} / ${a})`;

/** The teaching layer: BEV's cursor, boxes, highlights, arrows and notes over the whole desktop. */
export function Annotate() {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [spotlight, setSpotlight] = useState(false);
  const [cursor, setCursor] = useState<CursorState | null>(null);
  const [place, setPlace] = useState<{ origin: Pt; scale: number }>({ origin: { x: 0, y: 0 }, scale: window.devicePixelRatio || 1 });
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const w = getCurrentWindow();
    const measure = async () => {
      const [pos, scale] = await Promise.all([w.outerPosition(), w.scaleFactor()]);
      setPlace({ origin: { x: pos.x, y: pos.y }, scale });
      setView({ w: window.innerWidth, h: window.innerHeight });
    };
    void measure();
    const offs = [
      listen<LayerMessage>(LAYER_EVENT, (e) => {
        const m = e.payload;
        void measure();
        if (m.type === "clear") {
          setMarks([]);
          setSpotlight(false);
          setCursor(null);
        } else if (m.type === "cursor") setCursor(m.cursor);
        else {
          setMarks((old) => (m.replace ? m.marks : [...old.filter((o) => !m.marks.some((n) => n.id === o.id)), ...m.marks]));
          setSpotlight(m.spotlight);
        }
      }),
      w.onMoved(() => void measure()),
      w.onResized(() => void measure()),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, []);

  const L = (p: Pt) => toLayer(p, place.origin, place.scale);
  const highlights = marks.filter((m) => m.kind === "highlight");

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <style>{CSS}</style>
      {spotlight && highlights.length > 0 && <Spotlight holes={highlights.map((h) => ({ ...L({ x: h.rect.x, y: h.rect.y }), w: h.rect.w / place.scale, h: h.rect.h / place.scale }))} />}
      <svg width={view.w} height={view.h} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <defs>
          {(["accent", "good", "warn", "bad"] as Tone[]).map((t) => (
            <marker key={t} id={`head-${t}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={rgb(t)} />
            </marker>
          ))}
        </defs>
        {marks.map((m) => (
          <MarkShape key={m.id} m={m} L={L} scale={place.scale} />
        ))}
      </svg>
      {marks.map((m) => (
        <MarkLabel key={`l-${m.id}`} m={m} L={L} scale={place.scale} view={view} />
      ))}
      {cursor && <BevCursor c={cursor} at={L(cursor.at)} view={view} />}
    </div>
  );
}

function Spotlight({ holes }: { holes: Array<{ x: number; y: number; w: number; h: number }> }) {
  const pad = 8;
  return (
    <svg className="ann-fade" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <defs>
        <mask id="spot">
          <rect width="100%" height="100%" fill="white" />
          {holes.map((h, i) => (
            <rect key={i} x={h.x - pad} y={h.y - pad} width={h.w + pad * 2} height={h.h + pad * 2} rx={10} fill="black" />
          ))}
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgb(3 8 12 / 0.55)" mask="url(#spot)" />
    </svg>
  );
}

function MarkShape({ m, L, scale }: { m: Mark; L: (p: Pt) => Pt; scale: number }) {
  if (m.kind === "box" || m.kind === "highlight") {
    const p = L({ x: m.rect.x, y: m.rect.y });
    const w = m.rect.w / scale;
    const h = m.rect.h / scale;
    const pad = m.kind === "highlight" ? 6 : 4;
    return (
      <g className="ann-pop">
        {m.kind === "highlight" && <rect x={p.x - pad} y={p.y - pad} width={w + pad * 2} height={h + pad * 2} rx={8} fill={rgb(m.tone, 0.16)} className="ann-glow" style={{ color: rgb(m.tone) }} />}
        <rect
          x={p.x - pad}
          y={p.y - pad}
          width={w + pad * 2}
          height={h + pad * 2}
          rx={m.kind === "highlight" ? 8 : 4}
          fill="none"
          stroke={rgb(m.tone)}
          strokeWidth={m.kind === "highlight" ? 3 : 2.5}
          pathLength={100}
          className="ann-draw"
        />
      </g>
    );
  }
  if (m.kind === "circle") {
    const p = L(m.at);
    return <circle cx={p.x} cy={p.y} r={m.r / scale} fill={rgb(m.tone, 0.1)} stroke={rgb(m.tone)} strokeWidth={3} pathLength={100} className="ann-draw ann-pop" />;
  }
  if (m.kind === "arrow") {
    const a = L(m.from);
    const b = L(m.to);
    // A gentle curve reads better than a straight stick.
    const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.15;
    const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.15;
    return <path d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`} fill="none" stroke={rgb(m.tone)} strokeWidth={3.5} strokeLinecap="round" markerEnd={`url(#head-${m.tone ?? "accent"})`} pathLength={100} className="ann-draw" />;
  }
  return null;
}

function MarkLabel({ m, L, scale, view }: { m: Mark; L: (p: Pt) => Pt; scale: number; view: { w: number; h: number } }) {
  const text = m.kind === "note" ? m.text : m.label;
  const step = "step" in m ? m.step : undefined;
  if (!text && step === undefined) return null;
  let at: Pt;
  if (m.kind === "box" || m.kind === "highlight") {
    const p = L({ x: m.rect.x, y: m.rect.y });
    // Above the box; at the top of the screen, beside it (below would sit where BEV's cursor bubble goes).
    at = p.y < 60 ? { x: p.x + m.rect.w / scale + 14, y: p.y - 4 } : { x: p.x - 6, y: p.y - 40 };
  } else if (m.kind === "circle") {
    const p = L(m.at);
    at = { x: p.x + m.r / scale + 8, y: p.y - 16 };
  } else if (m.kind === "arrow") {
    const p = L(m.from);
    at = { x: p.x - 8, y: p.y - 40 };
  } else at = L(m.at);
  at = { x: Math.min(Math.max(8, at.x), view.w - 240), y: Math.min(Math.max(8, at.y), view.h - 48) };
  return (
    <div className="ann-label ann-pop" style={{ left: at.x, top: at.y, borderColor: rgb(m.tone, 0.7) }}>
      {step !== undefined && (
        <span className="ann-step" style={{ background: rgb(m.tone) }}>
          {step}
        </span>
      )}
      {text && <span>{text}</span>}
    </div>
  );
}

/** BEV's own pointer: a teal arrow with a ring, gliding between spots, with a speech bubble. */
function BevCursor({ c, at, view }: { c: CursorState; at: Pt; view: { w: number; h: number } }) {
  const bubble = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 260, h: 60 });
  useEffect(() => {
    if (bubble.current) setSize({ w: bubble.current.offsetWidth, h: bubble.current.offsetHeight });
  }, [c.say]);
  const spot = useMemo(() => bubbleSpot(at, size, view), [at, size, view]);
  return (
    <>
      <div className="ann-cursor" style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
        {c.pulse && <span key={`${at.x},${at.y}`} className="ann-ripple" />}
        <svg width="34" height="40" viewBox="0 0 34 40" style={{ position: "absolute", left: -3, top: -2, overflow: "visible" }}>
          <path d="M3 2 L3 30 L10.5 23.5 L15.5 35 L20.5 32.8 L15.6 21.6 L25.5 21.6 Z" fill="rgb(6 16 20)" stroke="rgb(78 205 222)" strokeWidth="2.2" strokeLinejoin="round" />
          <circle cx="3" cy="2" r="2.4" fill="rgb(132 224 236)" />
        </svg>
        <span className="ann-tag">BEV</span>
      </div>
      {c.say && (
        <div ref={bubble} className="ann-bubble" style={{ transform: `translate(${spot.x}px, ${spot.y}px)` }}>
          {c.say}
        </div>
      )}
    </>
  );
}

const CSS = `
.ann-label{position:absolute;display:flex;align-items:center;gap:8px;max-width:340px;padding:6px 11px;border:1px solid;border-radius:8px;
  background:rgb(8 14 19 / .92);color:#E6F1F4;font-size:14px;line-height:1.35;box-shadow:0 6px 24px rgb(0 0 0 / .45)}
.ann-step{flex:none;display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;color:rgb(4 20 23);font-weight:600;font-size:13px}
.ann-cursor{position:absolute;left:0;top:0;width:0;height:0;transition:transform .55s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 3px 6px rgb(0 0 0 / .55))}
.ann-tag{position:absolute;left:22px;top:30px;padding:1px 6px;border-radius:5px;background:rgb(78 205 222);color:rgb(4 20 23);font-size:11px;font-weight:600;letter-spacing:.04em}
.ann-ripple{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:2px solid rgb(78 205 222);animation:ann-ripple 1.2s ease-out 3}
.ann-bubble{position:absolute;left:0;top:0;max-width:320px;padding:9px 13px;border-radius:10px;border:1px solid rgb(78 205 222 / .55);
  background:rgb(8 14 19 / .95);color:#E6F1F4;font-size:15px;line-height:1.4;box-shadow:0 8px 28px rgb(0 0 0 / .5);
  transition:transform .55s cubic-bezier(.2,.8,.2,1);animation:ann-in .25s ease-out}
.ann-draw{stroke-dasharray:100;stroke-dashoffset:100;animation:ann-draw .5s ease-out forwards}
.ann-pop{animation:ann-in .25s ease-out}
.ann-glow{animation:ann-glow 1.8s ease-in-out infinite;filter:drop-shadow(0 0 10px currentColor)}
.ann-fade{animation:ann-in .3s ease-out}
@keyframes ann-draw{to{stroke-dashoffset:0}}
@keyframes ann-in{from{opacity:0}to{opacity:1}}
@keyframes ann-glow{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes ann-ripple{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}
@media (prefers-reduced-motion: reduce){.ann-cursor,.ann-bubble{transition:none}.ann-draw{animation:none;stroke-dashoffset:0}.ann-glow,.ann-ripple{animation:none}}
`;

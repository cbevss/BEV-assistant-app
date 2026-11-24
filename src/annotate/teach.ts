/**
 * Teaching on screen: BEV's cursor, boxes, highlights, arrows and notes drawn on
 * a click-through layer over every monitor (see annotate.rs), and a teaching
 * mode that keeps a long lesson going (more history, voice keeps listening).
 */
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import { controlCache, findText } from "@/lib/control";
import { LAYER_EVENT, type LayerMessage, type Mark, type Pt, type Rect, type Tone } from "./types";

export const useTeaching = create<{ on: boolean; topic: string; since: number }>(() => ({ on: false, topic: "", since: 0 }));
export const teachingOn = () => useTeaching.getState().on;

let shown = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Drawings fade after a while with no new ones (unless a lesson is running). */
const IDLE_CLEAR_MS = 90_000;

async function send(m: LayerMessage) {
  if (!shown) {
    await invoke("show_annotate");
    shown = true;
    await new Promise((r) => setTimeout(r, 60));
  }
  await emitTo("annotate", LAYER_EVENT, m);
  if (hideTimer) clearTimeout(hideTimer);
  if (m.type === "clear") {
    shown = false;
    await invoke("hide_annotate").catch(() => {});
  } else if (!teachingOn()) hideTimer = setTimeout(() => void clearScreen(), IDLE_CLEAR_MS);
}

export async function clearScreen() {
  if (!shown) return;
  await send({ type: "clear" });
}

// ---------------------------------------------------------------------------
// Where things are: text BEV reads on screen, a control from read_app_controls,
// or x/y (and w/h) on the last look_at_screen image.

type Target = { text?: unknown; control?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown };

const n = (v: unknown, name: string): number => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} must be a number`);
  return x;
};

let ocrAt = 0;
async function textRect(text: string): Promise<Rect> {
  let hits = Date.now() - ocrAt < 4000 ? findText(controlCache.ocr()?.lines ?? [], text) : [];
  if (!hits.length) {
    const fresh = await native.screenOcr("all");
    controlCache.setOcr(fresh);
    ocrAt = Date.now();
    hits = findText(fresh.lines, text);
  }
  if (!hits.length) throw new Error(`Couldn't find "${text}" on screen. Look at the screen and give x/y instead.`);
  const [x, y, w, h] = hits[0].rect;
  return { x, y, w, h };
}

async function shotPoints(pts: Array<[number, number]>): Promise<Pt[]> {
  const out = await invoke<Array<[number, number] | null>>("shot_points_to_screen", { points: pts });
  if (out.some((p) => !p)) throw new Error("That point is outside the last screenshot. Look at the screen again first.");
  return out.map((p) => ({ x: p![0], y: p![1] }));
}

/** A target → a rectangle in desktop pixels (a point gives a small square). */
export async function resolveRect(t: Target): Promise<Rect> {
  if (typeof t.text === "string" && t.text.trim()) return textRect(t.text.trim());
  if (t.control !== undefined) {
    const el = controlCache.element(n(t.control, "control"));
    if (!el) throw new Error("That control id isn't from the last read_app_controls. Read the controls again.");
    const [x, y, w, h] = el.rect;
    return { x, y, w, h };
  }
  if (t.x === undefined || t.y === undefined) throw new Error("say where: text, control, or x and y on the last screenshot");
  const x = n(t.x, "x");
  const y = n(t.y, "y");
  const w = t.w === undefined ? 0 : n(t.w, "w");
  const h = t.h === undefined ? 0 : n(t.h, "h");
  const [a, b] = await shotPoints([
    [x, y],
    [x + w, y + h],
  ]);
  const size = w || h ? { w: b.x - a.x, h: b.y - a.y } : { w: 0, h: 0 };
  return w || h ? { x: a.x, y: a.y, ...size } : { x: a.x - 14, y: a.y - 14, w: 28, h: 28 };
}

export const centreOf = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const TONE = new Set(["accent", "good", "warn", "bad"]);
const tone = (v: unknown): Tone | undefined => (TONE.has(String(v)) ? (String(v) as Tone) : undefined);
const short = (v: unknown, max = 160) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

let seq = 0;
/** One mark from the AI's description. */
export async function buildMark(raw: Record<string, unknown>): Promise<Mark> {
  const kind = String(raw.kind ?? "box");
  const id = `m${++seq}`;
  const label = short(raw.label);
  const step = raw.step === undefined ? undefined : Math.round(n(raw.step, "step"));
  if (kind === "arrow") {
    const to = centreOf(await resolveRect(raw as Target));
    const from =
      raw.from_x !== undefined && raw.from_y !== undefined
        ? (await shotPoints([[n(raw.from_x, "from_x"), n(raw.from_y, "from_y")]]))[0]
        : { x: to.x - 140, y: to.y - 110 };
    return { kind: "arrow", id, from, to, label, tone: tone(raw.tone) };
  }
  const rect = await resolveRect(raw as Target);
  if (kind === "note") return { kind: "note", id, at: { x: rect.x, y: rect.y }, text: label ?? short(raw.text) ?? "", tone: tone(raw.tone) };
  if (kind === "circle") return { kind: "circle", id, at: centreOf(rect), r: Math.max(22, Math.max(rect.w, rect.h) / 2 + 10), label, tone: tone(raw.tone), step };
  return { kind: kind === "highlight" ? "highlight" : "box", id, rect, label, tone: tone(raw.tone), step };
}

// ---------------------------------------------------------------------------
// Tools

const WHERE = {
  text: { type: "string", description: "visible text to point at (BEV reads the screen to find it): the most reliable way" },
  control: { type: "number", description: "or a control id from read_app_controls" },
  x: { type: "number", description: "or x on the last look_at_screen image" },
  y: { type: "number" },
};

export function teachTools(): Record<string, RegisteredTool> {
  return {
    point_at: {
      spec: {
        name: "point_at",
        description:
          "Move BEV's own on-screen cursor (separate from the user's mouse; it never clicks) to something and say a short line about it in a bubble. Use it to show the user where things are while teaching or explaining. Find the spot by text, control id, or x/y on the last look_at_screen.",
        parameters: {
          type: "object",
          properties: { ...WHERE, say: { type: "string", description: "one short line shown next to the cursor, e.g. 'Click File first'" }, pulse: { type: "boolean", description: "ripple to say 'click here'" } },
          required: [],
        },
      },
      run: async (a) => {
        const r = await resolveRect(a);
        await send({ type: "cursor", cursor: { at: centreOf(r), say: short(a.say, 220), pulse: a.pulse === true || a.pulse === "true" } });
        return `Pointing at ${typeof a.text === "string" ? `"${a.text}"` : "that spot"}.`;
      },
    },
    annotate_screen: {
      spec: {
        name: "annotate_screen",
        description:
          "Draw on the user's screen to teach or show them things: box (outline), highlight (glowing; with spotlight the rest of the screen dims), circle, arrow (pointing at the target) or note (a label at a spot). Each mark finds its spot by text, control id, or x/y (with w/h for a size) on the last look_at_screen. Add step numbers for a sequence. Drawings are click-through and the user's own screen works as normal. Look at the screen first to know what's there.",
        parameters: {
          type: "object",
          properties: {
            marks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["box", "highlight", "circle", "arrow", "note"] },
                  ...WHERE,
                  w: { type: "number", description: "width on the screenshot (with x/y)" },
                  h: { type: "number" },
                  from_x: { type: "number", description: "arrow: where it starts on the screenshot (default: up-left of the target)" },
                  from_y: { type: "number" },
                  label: { type: "string", description: "short text shown with it" },
                  step: { type: "number", description: "step number badge (1, 2, 3…)" },
                  tone: { type: "string", enum: ["accent", "good", "warn", "bad"] },
                },
                required: ["kind"],
              },
            },
            keep: { type: "boolean", description: "add to what's already drawn instead of replacing it" },
            spotlight: { type: "boolean", description: "dim everything except highlights" },
          },
          required: ["marks"],
        },
      },
      run: async (a) => {
        const list = Array.isArray(a.marks) ? (a.marks as Record<string, unknown>[]).slice(0, 20) : [];
        if (!list.length) throw new Error("give at least one mark");
        const marks: Mark[] = [];
        const problems: string[] = [];
        for (const raw of list) {
          try {
            marks.push(await buildMark(raw));
          } catch (e) {
            problems.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (!marks.length) throw new Error(problems[0] ?? "nothing to draw");
        await send({ type: "draw", marks, replace: !(a.keep === true || a.keep === "true"), spotlight: a.spotlight === true || a.spotlight === "true" });
        return `Drew ${marks.length} mark${marks.length === 1 ? "" : "s"} on screen.${problems.length ? ` Skipped: ${problems.join("; ")}` : ""}`;
      },
    },
    clear_annotations: {
      spec: { name: "clear_annotations", description: "Remove BEV's drawings and cursor from the screen.", parameters: { type: "object", properties: {}, required: [] } },
      run: async () => {
        await clearScreen();
        return "Cleared.";
      },
    },
    teaching_mode: {
      spec: {
        name: "teaching_mode",
        description:
          "Start (on) when the user wants to be taught or walked through something on their PC, and stop (off) when the lesson's done or they say so. While on, BEV keeps the whole lesson in mind (a long conversation), keeps listening between steps, and keeps its drawings up.",
        parameters: { type: "object", properties: { on: { type: "boolean" }, topic: { type: "string", description: "what's being taught" } }, required: ["on"] },
      },
      run: async (a) => {
        const on = a.on === true || a.on === "true";
        useTeaching.setState({ on, topic: on ? short(a.topic, 120) ?? "" : "", since: on ? Date.now() : 0 });
        if (!on) await clearScreen();
        return on
          ? "Teaching mode on. Go one step at a time: look at the screen, point at or mark the next thing, say what to do, then wait for them. Check their screen before the next step."
          : "Teaching mode off.";
      },
    },
  };
}

/** For the system prompt while teaching. */
export function teachingPrompt(): string {
  const t = useTeaching.getState();
  if (!t.on) return "";
  return `TEACHING MODE${t.topic ? ` (${t.topic})` : ""}: you're teaching the user on their own screen. One step at a time: look_at_screen, then point_at / annotate_screen the exact thing (prefer text targets), say in a sentence or two what to do and why, then stop and let them do it. Next turn, look again to check before moving on; if they went wrong, show them where. Keep earlier steps in mind. Don't do the steps for them unless they ask.`;
}

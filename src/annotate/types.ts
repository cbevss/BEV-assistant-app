/**
 * What BEV draws on the teaching layer. All coordinates are desktop pixels
 * (physical, across every monitor); the layer turns them into its own.
 */
export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };
export type Tone = "accent" | "good" | "warn" | "bad";

export type Mark =
  | { kind: "box"; id: string; rect: Rect; label?: string; tone?: Tone; step?: number }
  | { kind: "highlight"; id: string; rect: Rect; label?: string; tone?: Tone; step?: number }
  | { kind: "circle"; id: string; at: Pt; r: number; label?: string; tone?: Tone; step?: number }
  | { kind: "arrow"; id: string; from: Pt; to: Pt; label?: string; tone?: Tone }
  | { kind: "note"; id: string; at: Pt; text: string; tone?: Tone };

export interface CursorState {
  at: Pt;
  /** What BEV is saying about this spot, shown in a bubble next to its cursor. */
  say?: string;
  /** A small "click here" ripple. */
  pulse?: boolean;
}

export type LayerMessage =
  | { type: "draw"; marks: Mark[]; replace: boolean; spotlight: boolean }
  | { type: "cursor"; cursor: CursorState | null }
  | { type: "clear" };

export const LAYER_EVENT = "bev://annotate";

/** Desktop pixels → CSS pixels on a layer placed at `origin` with `scale` device pixels per CSS pixel. Pure; tested. */
export function toLayer(p: Pt, origin: Pt, scale: number): Pt {
  const s = scale > 0 ? scale : 1;
  return { x: (p.x - origin.x) / s, y: (p.y - origin.y) / s };
}

/** A bubble placed beside a point, kept on screen. Pure; tested. */
export function bubbleSpot(at: Pt, size: { w: number; h: number }, view: { w: number; h: number }): Pt {
  let x = at.x + 28;
  let y = at.y + 50;
  if (x + size.w > view.w - 8) x = at.x - size.w - 18;
  if (y + size.h > view.h - 8) y = at.y - size.h - 14;
  return { x: Math.max(8, x), y: Math.max(8, y) };
}

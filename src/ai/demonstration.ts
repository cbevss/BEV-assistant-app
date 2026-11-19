/**
 * "Watch me": turning a recorded demonstration (clicks and key presses) into
 * routine steps BEV can repeat. Clicks become "click <name> in <app>", a click
 * into a text box followed by typing becomes "type … into <name>", shortcuts
 * become key presses. Typing into password boxes is never kept.
 */
import type { RoutineStep } from "@/routines/types";

export interface RecTarget {
  name: string;
  role: string;
  process: string;
  password: boolean;
}

export type RecEvent =
  | { kind: "click"; t: number; x: number; y: number; button: "left" | "right"; target: RecTarget | null }
  | { kind: "key"; t: number; vk: number; ctrl: boolean; alt: boolean; shift: boolean; win: boolean };

export interface Demonstration {
  steps: RoutineStep[];
  /** What couldn't be turned into a step, in plain words. */
  skipped: string[];
}

const TEXT_ROLES = new Set(["edit", "document", "combobox", "text"]);
const MODIFIERS = new Set([0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c, 0x14]);

const NAMED: Record<number, string> = {
  0x08: "backspace",
  0x09: "tab",
  0x0d: "enter",
  0x1b: "escape",
  0x21: "pageup",
  0x22: "pagedown",
  0x23: "end",
  0x24: "home",
  0x25: "left",
  0x26: "up",
  0x27: "right",
  0x28: "down",
  0x2e: "delete",
};
for (let i = 1; i <= 12; i++) NAMED[0x6f + i] = `f${i}`;

// UK keyboard layout (unshifted, shifted).
const OEM: Record<number, [string, string]> = {
  0x20: [" ", " "],
  0xba: [";", ":"],
  0xbb: ["=", "+"],
  0xbc: [",", "<"],
  0xbd: ["-", "_"],
  0xbe: [".", ">"],
  0xbf: ["/", "?"],
  0xc0: ["'", "@"],
  0xdb: ["[", "{"],
  0xdc: ["\\", "|"],
  0xdd: ["]", "}"],
  0xde: ["#", "~"],
  0xdf: ["`", "¬"],
};
const SHIFTED_DIGITS = ')!"£$%^&*(';

/** The character a key press types, or null if it isn't a typing key. */
export function charFor(vk: number, shift: boolean): string | null {
  if (vk >= 0x41 && vk <= 0x5a) {
    const c = String.fromCharCode(vk);
    return shift ? c : c.toLowerCase();
  }
  if (vk >= 0x30 && vk <= 0x39) return shift ? SHIFTED_DIGITS[vk - 0x30] : String(vk - 0x30);
  if (vk >= 0x60 && vk <= 0x69) return String(vk - 0x60); // numpad
  const o = OEM[vk];
  return o ? (shift ? o[1] : o[0]) : null;
}

function keyName(vk: number): string {
  if (NAMED[vk]) return NAMED[vk];
  const c = charFor(vk, false);
  return c && c !== " " ? c : c === " " ? "space" : `vk${vk}`;
}

const appOf = (process: string) => process.replace(/\.exe$/i, "");

export function demonstrationToSteps(events: RecEvent[]): Demonstration {
  const steps: RoutineStep[] = [];
  const skipped: string[] = [];
  let text = "";
  /** Index of the click into a text box that typing should go into. */
  let editStep = -1;
  let inPassword = false;
  let lastT = events[0]?.t ?? 0;
  let pendingGap = 0;

  const add = (s: Omit<RoutineStep, "id" | "delayMs">, t: number) => {
    const gap = steps.length ? Math.min(3000, Math.max(300, t - lastT + pendingGap)) : 0;
    steps.push({ id: crypto.randomUUID(), ...s, ...(gap ? { delayMs: gap } : {}) });
    lastT = t;
    pendingGap = 0;
  };

  const flushText = (t: number) => {
    if (!text) return;
    if (editStep >= 0) {
      // "Click the box, then type" becomes one step: type into that box.
      const s = steps[editStep];
      steps[editStep] = { ...s, args: { ...s.args, action: "type", text } };
    } else {
      add({ tool: "type_text", args: { text } }, t);
    }
    text = "";
  };

  for (const e of events) {
    if (e.kind === "click") {
      flushText(e.t);
      editStep = -1;
      const tgt = e.target;
      inPassword = !!tgt?.password;
      if (inPassword) {
        skipped.push("Typing in a password box (BEV never repeats passwords)");
        continue;
      }
      if (e.button === "right") {
        skipped.push(`A right-click${tgt?.name ? ` on "${tgt.name}"` : ""}`);
        continue;
      }
      if (!tgt || !tgt.name.trim()) {
        skipped.push("A click on something without a name (BEV can't find it again)");
        continue;
      }
      add({ tool: "use_named_control", args: { app: appOf(tgt.process), name: tgt.name, role: tgt.role, action: "click" } }, e.t);
      if (TEXT_ROLES.has(tgt.role)) editStep = steps.length - 1;
      continue;
    }

    // Keys
    if (MODIFIERS.has(e.vk)) continue;
    if (inPassword) continue;
    const combo = e.ctrl || e.alt || e.win;
    const ch = combo ? null : charFor(e.vk, e.shift);
    if (ch !== null) {
      text += ch;
      continue;
    }
    if (e.vk === 0x08 && text) {
      text = text.slice(0, -1);
      continue;
    }
    flushText(e.t);
    if (!combo) editStep = -1;
    const keys = [e.ctrl && "ctrl", e.alt && "alt", e.shift && combo && "shift", e.win && "win", keyName(e.vk)].filter(Boolean).join("+");
    add({ tool: "press_keys", args: { keys } }, e.t);
  }
  flushText(lastT);
  return { steps, skipped };
}

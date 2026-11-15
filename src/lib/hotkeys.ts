/**
 * Keyboard event → Tauri global-shortcut accelerator ("CommandOrControl+Alt+M").
 * Returns null while only modifiers are held, or for keys that can't be a
 * hotkey. A plain key needs a modifier (so typing isn't hijacked), except
 * F1–F24 and media-style keys, which are fine alone.
 */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const NAMED: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Pause: "Pause",
  ScrollLock: "ScrollLock",
  PrintScreen: "PrintScreen",
};

/** Keys that make sense on their own, without Ctrl/Alt/Shift. */
const SOLO = /^(F([1-9]|1\d|2[0-4])|Pause|ScrollLock|Insert|Num[0-9]|NumAdd|NumSubtract|NumMultiply|NumDivide)$/;

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `Num${code.slice(6)}`;
  const np: Record<string, string> = {
    NumpadAdd: "NumAdd",
    NumpadSubtract: "NumSubtract",
    NumpadMultiply: "NumMultiply",
    NumpadDivide: "NumDivide",
  };
  return np[code] ?? NAMED[code] ?? null;
}

export function acceleratorFromEvent(e: KeyLike): string | null {
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(e.code)) return null;
  const key = keyName(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (!mods.length && !SOLO.test(key)) return null;
  // Shift alone + a letter would just be a capital letter.
  if (mods.length === 1 && mods[0] === "Shift" && !SOLO.test(key)) return null;
  return [...mods, key].join("+");
}

/** "CommandOrControl+Alt+M" → "Ctrl + Alt + M" for display. */
export function prettyAccelerator(a: string): string {
  if (!a) return "";
  return a
    .split("+")
    .map((p) => ({ CommandOrControl: "Ctrl", Control: "Ctrl", Super: "Win" })[p] ?? p)
    .join(" + ");
}

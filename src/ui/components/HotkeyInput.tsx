import { useState } from "react";
import clsx from "clsx";
import { acceleratorFromEvent, prettyAccelerator } from "@/lib/hotkeys";
import { Button } from "./Form";

/**
 * Click, then press the key combination. Esc cancels; Clear removes it.
 * `onChange` should apply the hotkey and return an error message if it
 * couldn't be registered, so the user sees it straight away.
 */
export function HotkeyInput({
  value,
  onChange,
  ariaLabel,
  placeholder = "Not set",
}: {
  value: string;
  onChange: (accelerator: string) => Promise<string | null>;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = async (a: string) => {
    setRecording(false);
    setErr(await onChange(a));
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={() => {
            setErr(null);
            setRecording(true);
          }}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            if (!recording) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.code === "Escape") return setRecording(false);
            const a = acceleratorFromEvent(e);
            if (a) commit(a);
          }}
          className={clsx(
            "min-w-[11rem] rounded-lg border px-3 py-1.5 text-left text-sm",
            recording
              ? "border-accent/60 bg-accent/10 text-accent"
              : "border-line bg-surface-2 text-ink hover:border-line-strong"
          )}
        >
          {recording ? "Press keys… (Esc to cancel)" : prettyAccelerator(value) || <span className="text-ink-3">{placeholder}</span>}
        </button>
        {value && !recording && (
          <Button variant="ghost" onClick={() => commit("")}>
            Clear
          </Button>
        )}
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
    </div>
  );
}

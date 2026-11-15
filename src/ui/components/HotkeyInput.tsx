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
              ? "border-bev-cyan/60 bg-bev-cyan/10 text-bev-cyan"
              : "border-white/10 bg-white/5 text-slate-200 hover:border-white/20"
          )}
        >
          {recording ? "Press keys… (Esc to cancel)" : prettyAccelerator(value) || <span className="text-slate-500">{placeholder}</span>}
        </button>
        {value && !recording && (
          <Button variant="ghost" onClick={() => commit("")}>
            Clear
          </Button>
        )}
      </div>
      {err && <p className="text-xs text-bev-danger">{err}</p>}
    </div>
  );
}

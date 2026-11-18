/** Modal dialog: focus moves in, Esc closes, Tab stays inside, focus returns afterwards. */
import { ReactNode, useEffect, useRef } from "react";
import clsx from "clsx";

export function Dialog({ title, children, footer, onClose, tone, width = 440 }: { title: string; children?: ReactNode; footer: ReactNode; onClose: () => void; tone?: "danger" | "accent"; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute("disabled"));
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 animate-fade-in">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        style={{ width }}
        className={clsx("max-w-full rounded-xl bg-surface-1 shadow-pop animate-scale-in", tone === "danger" && "border-t-2 border-danger", tone === "accent" && "border-t-2 border-accent")}
      >
        <div className="px-5 pb-4 pt-5">
          <h2 id="dlg-title" className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {children && <div className="mt-2 text-sm text-ink-2">{children}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line-subtle px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

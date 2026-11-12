import { ReactNode } from "react";
import clsx from "clsx";

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold text-glow">{title}</h1>
      {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
    </header>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="glass mb-5 rounded-xl p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-widest text-slate-400">{title}</h2>
        {aside}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="md:w-1/2">
        <div className="text-sm text-slate-200">{label}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
      <div className="md:w-1/2 md:max-w-sm">{children}</div>
    </div>
  );
}

const inputCls =
  "no-drag w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-bev-cyan/60 focus:ring-1 focus:ring-bev-cyan/40";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputCls, props.className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(inputCls, "min-h-[80px] resize-y", props.className)} />;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={clsx(inputCls, "cursor-pointer")}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-carbon">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx(
        "no-drag relative h-6 w-11 rounded-full transition",
        checked ? "bg-bev-cyan/70 shadow-glow" : "bg-white/10"
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all",
          checked ? "left-[22px]" : "left-0.5"
        )}
      />
    </button>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={ariaLabel}
        className="no-drag flex-1 accent-cyan-400"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-14 text-right font-mono text-xs text-slate-300">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...rest}
      className={clsx(
        "no-drag rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-bev-cyan/20 text-bev-cyan shadow-glow hover:bg-bev-cyan/30",
        variant === "ghost" && "text-slate-300 hover:bg-white/5",
        variant === "danger" && "bg-bev-danger/15 text-bev-danger hover:bg-bev-danger/25",
        className
      )}
    >
      {children}
    </button>
  );
}

export function StatusPill({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs",
        ok === null && "bg-white/5 text-slate-400",
        ok === true && "bg-bev-ok/15 text-bev-ok",
        ok === false && "bg-bev-danger/15 text-bev-danger"
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", ok === null ? "bg-slate-500" : ok ? "bg-bev-ok" : "bg-bev-danger")} />
      {label}
    </span>
  );
}

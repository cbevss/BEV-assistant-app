/**
 * BEV's shared controls. One source for every input, button and settings row
 * so screens stay consistent; tokens come from tailwind.config.js and
 * src/styles.css (docs/DESIGN.md).
 */
import { forwardRef, ReactNode } from "react";
import clsx from "clsx";
import { ChevronDown, Loader2, type LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Page structure

/** Page heading: the window title bar already names the page, so this is compact. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 max-w-[68ch] text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A group of related settings or content: a quiet heading above one panel
 * whose rows are separated by hairlines. Each direct child is a row.
 */
export function Section({ title, description, children, aside, flush }: { title: string; description?: string; children: ReactNode; aside?: ReactNode; flush?: boolean }) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex min-h-[28px] items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 max-w-[72ch] text-xs text-ink-3">{description}</p>}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      <div
        className={clsx(
          "rounded-lg border border-line-subtle bg-surface-1",
          !flush && "divide-y divide-line-subtle [&>*]:px-4 [&>*]:py-3 [&>*:empty]:hidden"
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** One setting: label and explanation on the left, its control on the right. */
export function Field({ label, hint, children, stacked }: { label: string; hint?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={clsx("flex gap-x-8 gap-y-2", stacked ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between")}>
      <div className="min-w-0 sm:max-w-[56ch]">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
      </div>
      <div className={clsx("min-w-0", !stacked && "sm:flex sm:w-[300px] sm:shrink-0 sm:justify-end")}>{children}</div>
    </div>
  );
}

/** A plain surface for content that isn't a settings list. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("rounded-lg border border-line-subtle bg-surface-1", className)}>{children}</div>;
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {Icon && <Icon className="mb-3 h-5 w-5 text-ink-4" strokeWidth={1.75} aria-hidden />}
      <div className="text-sm text-ink-2">{title}</div>
      {children && <div className="mt-1 max-w-[48ch] text-xs text-ink-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs

const field =
  "no-drag h-8 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink placeholder:text-ink-4 transition-colors duration-fast " +
  "hover:border-line-strong focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50";

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput(props, ref) {
  return <input ref={ref} {...props} className={clsx(field, props.className)} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(props, ref) {
  return <textarea ref={ref} {...props} className={clsx(field, "h-auto min-h-[84px] resize-y py-2 leading-5", props.className)} />;
});

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx("relative w-full", className)}>
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        className={clsx(field, "cursor-pointer appearance-none pr-8")}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-surface-2 text-ink">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "no-drag relative h-[18px] w-8 shrink-0 rounded-full border transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3 hover:border-ink-4"
      )}
    >
      <span
        className={clsx(
          "absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-[left,background-color] duration-fast ease-out",
          checked ? "left-[15px] bg-accent-ink" : "left-[2px] bg-ink-2"
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
  const fill = `${((value - min) / (max - min || 1)) * 100}%`;
  return (
    <div className="flex w-full items-center gap-3">
      <input
        type="range"
        aria-label={ariaLabel}
        className="bev-range no-drag flex-1"
        style={{ ["--fill" as string]: fill }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="tnum w-12 text-right font-mono text-xs text-ink-2">{format ? format(value) : value}</span>
    </div>
  );
}

/** A small set of mutually exclusive options shown side by side. */
export function Segmented<T extends string>({ value, onChange, options, ariaLabel }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; ariaLabel?: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-6 rounded-sm px-2.5 text-xs transition-colors duration-fast",
            value === o.value ? "bg-surface-3 text-ink shadow-[0_0_0_1px_rgb(var(--line-strong))]" : "text-ink-3 hover:text-ink"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  icon: Icon,
  loading,
  className,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "no-drag inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
        size === "md" ? "h-8 px-3 text-sm" : "h-7 px-2.5 text-xs",
        variant === "primary" && "bg-accent text-accent-ink hover:bg-accent-strong active:brightness-95",
        variant === "secondary" && "border border-line bg-surface-2 text-ink hover:border-line-strong hover:bg-surface-3",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-danger/30 text-danger hover:border-danger/50 hover:bg-danger/10",
        className
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-orbit" aria-hidden /> : Icon ? <Icon className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Square icon-only button; always pass a label (used for the tooltip too). */
export function IconButton({ icon: Icon, label, active, className, size = "md", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={clsx(
        "no-drag grid shrink-0 place-items-center rounded transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
        size === "md" ? "h-8 w-8" : "h-7 w-7",
        active ? "bg-accent/15 text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
        className
      )}
    >
      <Icon className={size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"} strokeWidth={1.8} aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status

/** Small status marker: dot + words. ok=null means neutral / not set up. */
export function StatusPill({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs", ok === null ? "text-ink-3" : ok ? "text-ok" : "text-danger")}>
      <span className={clsx("h-1.5 w-1.5 rounded-full", ok === null ? "bg-ink-4" : ok ? "bg-ok" : "bg-danger")} aria-hidden />
      {label}
    </span>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger" }) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 items-center rounded-sm px-1.5 text-2xs font-medium",
        tone === "neutral" && "bg-surface-3 text-ink-2",
        tone === "accent" && "bg-accent/15 text-accent",
        tone === "ok" && "bg-ok/15 text-ok",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "danger" && "bg-danger/15 text-danger"
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm border border-line bg-surface-2 px-1 font-mono text-2xs text-ink-3">{children}</kbd>;
}

/** A notice inside a section: info, warning or error, with an optional action. */
export function Notice({ tone = "warn", children, action }: { tone?: "info" | "warn" | "danger" | "ok"; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={clsx(
        "flex items-start justify-between gap-4 rounded border-l-2 px-3 py-2 text-sm",
        tone === "info" && "border-accent bg-accent/5 text-ink-2",
        tone === "warn" && "border-warn bg-warn/5 text-ink-2",
        tone === "danger" && "border-danger bg-danger/5 text-ink-2",
        tone === "ok" && "border-ok bg-ok/5 text-ink-2"
      )}
    >
      <div className="min-w-0">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

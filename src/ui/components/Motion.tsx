/**
 * Motion helpers. One rule: things move to show what changed or that BEV is
 * alive, never just to decorate. Everything here is CSS transitions/keyframes,
 * so Windows' reduced-motion setting and BEV's Motion setting switch it off.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import clsx from "clsx";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the `[data-active="true"]` child of a container is, kept up to date. */
export function useActiveRect(container: RefObject<HTMLElement>, key: unknown): { rect: Rect | null; ready: boolean } {
  const [rect, setRect] = useState<Rect | null>(null);
  const [ready, setReady] = useState(false);
  const first = useRef(true);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>('[data-active="true"]');
      setRect(el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null);
    };
    measure();
    // Don't animate the very first placement; slide only on later changes.
    if (first.current) {
      first.current = false;
      requestAnimationFrame(() => setReady(true));
    }
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [container, key]);
  return { rect, ready };
}

/** The highlight behind the active item of a vertical list, which glides between items. */
export function SlidingHighlight({ rect, ready }: { rect: Rect | null; ready: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "pointer-events-none absolute left-0 top-0 rounded bg-surface-2",
        ready && "transition-[transform,width,height,opacity] duration-[260ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      )}
      style={rect ? { transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h, opacity: 1 } : { opacity: 0 }}
    >
      {/* the accent tick at the leading edge */}
      <span className="absolute left-0 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-accent" />
    </span>
  );
}

/** The underline under the active tab of a horizontal tab bar, which glides between tabs. */
export function SlidingUnderline({ rect, ready }: { rect: Rect | null; ready: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "pointer-events-none absolute bottom-[-1px] left-0 h-0.5 rounded-full bg-accent",
        ready && "transition-[transform,width] duration-[260ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      )}
      style={rect ? { transform: `translateX(${rect.x}px)`, width: rect.w } : { opacity: 0 }}
    />
  );
}

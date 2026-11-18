import { useEffect, useState } from "react";
import { useSettings, OverlayCorner } from "@/state/settings";
import { native } from "@/lib/native";
import { applyAppearance } from "@/lib/appearance";
import { previewOverlay } from "@/lib/overlayPlacement";
import { PageHeader, Section, Field, Select, Slider, Toggle, Button } from "../components/Form";

/** Restrained signal colours that hold up on the graphite surfaces. */
const PRESETS: Array<{ hex: string; name: string }> = [
  { hex: "#4ecdde", name: "Signal cyan" },
  { hex: "#6aa6ff", name: "Ice blue" },
  { hex: "#5fd1a5", name: "Mint" },
  { hex: "#e8b04b", name: "Amber" },
  { hex: "#ef7f6a", name: "Coral" },
  { hex: "#d6dbe2", name: "Graphite white" },
];

export function Appearance() {
  const { settings, update } = useSettings();
  const [monitors, setMonitors] = useState<{ index: number; name: string; primary: boolean }[]>([]);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    native.listMonitors().then(setMonitors).catch(() => setMonitors([]));
  }, []);

  const set = (patch: Partial<typeof settings>) => {
    update(patch).then(() => applyAppearance({ ...settings, ...patch }));
  };

  return (
    <div>
      <PageHeader title="Appearance" subtitle="BEV's accent colour, where the overlay appears and how much moves." />

      <Section title="Accent colour">
        <Field label="Colour" hint="Used sparingly: active states, BEV's Core and the main action on a screen.">
          <div className="flex items-center gap-2">
            {PRESETS.map((c) => (
              <button
                key={c.hex}
                aria-label={c.name}
                title={c.name}
                aria-pressed={settings.accent.toLowerCase() === c.hex}
                onClick={() => set({ accent: c.hex })}
                className={`grid h-6 w-6 place-items-center rounded-full transition-shadow duration-fast ${settings.accent.toLowerCase() === c.hex ? "shadow-[0_0_0_2px_rgb(var(--canvas)),0_0_0_3.5px_rgb(var(--ink))]" : "hover:shadow-[0_0_0_2px_rgb(var(--canvas)),0_0_0_3.5px_rgb(var(--line-strong))]"}`}
                style={{ background: c.hex }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom accent"
              title="Custom colour"
              className="no-drag ml-1 h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
              value={settings.accent}
              onChange={(e) => set({ accent: e.target.value })}
            />
          </div>
        </Field>
      </Section>

      <Section title="Overlay">
        <Field label="Position" hint="Where the holographic overlay appears.">
          <Select<OverlayCorner>
            ariaLabel="Overlay corner"
            value={settings.overlayCorner}
            onChange={(overlayCorner) => set({ overlayCorner })}
            options={[
              { value: "top-right", label: "Top right" },
              { value: "top-left", label: "Top left" },
              { value: "bottom-right", label: "Bottom right" },
              { value: "bottom-left", label: "Bottom left" },
              { value: "center", label: "Centre" },
            ]}
          />
        </Field>
        <Field label="Size">
          <Slider
            ariaLabel="Overlay size"
            min={0.7}
            max={1.5}
            step={0.05}
            value={settings.overlayScale}
            onChange={(overlayScale) => set({ overlayScale })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Field>
        {monitors.length > 1 && (
          <p className="text-xs text-ink-3">
            {monitors.length} monitors detected. The overlay follows the primary display; multi-monitor targeting is on the roadmap.
          </p>
        )}
        <div className="flex justify-end">
          <Button
            variant="ghost"
            disabled={previewing}
            onClick={() => {
              setPreviewing(true);
              previewOverlay()
                .catch(() => {})
                .finally(() => setPreviewing(false));
            }}
          >
            {previewing ? "Previewing…" : "Preview overlay"}
          </Button>
        </div>
      </Section>

      <Section title="Motion">
        <Field label="Reduced motion" hint="Calms animations. Applies to the overlay after its next activation.">
          <Toggle label="Reduced motion" checked={settings.reducedMotion} onChange={(reducedMotion) => set({ reducedMotion })} />
        </Field>
      </Section>
    </div>
  );
}

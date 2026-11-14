import { useEffect, useState } from "react";
import { useSettings, OverlayCorner } from "@/state/settings";
import { native } from "@/lib/native";
import { applyAppearance } from "@/lib/appearance";
import { previewOverlay } from "@/lib/overlayPlacement";
import { PageHeader, Section, Field, Select, Slider, Toggle, Button } from "../components/Form";

const PRESETS = ["#22d3ee", "#3b82f6", "#8b5cf6", "#34d399", "#f43f5e", "#f59e0b"];

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
      <PageHeader title="Appearance" subtitle="Accent colour, overlay placement and motion." />

      <Section title="Accent colour">
        <Field label="Colour" hint="Used across highlights and the idle indicator.">
          <div className="flex items-center gap-2">
            {PRESETS.map((c) => (
              <button
                key={c}
                aria-label={`Accent ${c}`}
                onClick={() => set({ accent: c })}
                className={`h-7 w-7 rounded-full border-2 transition ${settings.accent === c ? "border-white" : "border-transparent"}`}
                style={{ background: c }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom accent"
              className="no-drag h-7 w-10 cursor-pointer rounded bg-transparent"
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
          <p className="text-xs text-slate-500">
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

import { useEffect, useState } from "react";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { useSettings, Personality } from "@/state/settings";
import { PageHeader, Section, Field, Select, Slider, Toggle, TextArea, Button } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function Settings() {
  const { settings, update, reset } = useSettings();
  const [version, setVersion] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("?"));
    autostartEnabled().then(setAutostart).catch(() => setAutostart(null));
  }, []);

  const toggleAutostart = async (on: boolean) => {
    try {
      if (on) await enableAutostart();
      else await disableAutostart();
      setAutostart(on);
      update({ startWithWindows: on });
    } catch {
      /* permission or platform issue — leave the real state as read */
      setAutostart(await autostartEnabled().catch(() => false));
    }
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Startup, personality, performance and diagnostics." />

      <Section title="Startup & background">
        <Field label="Start BEV with Windows" hint="Launches minimised to the tray on sign-in.">
          <Toggle label="Start with Windows" checked={!!autostart} onChange={toggleAutostart} />
        </Field>
      </Section>

      <Section title="Personality">
        <Field label="Style">
          <Select<Personality>
            ariaLabel="Personality"
            value={settings.personality}
            onChange={(personality) => update({ personality })}
            options={[
              { value: "casual", label: "Casual" },
              { value: "professional", label: "Professional" },
              { value: "minimal", label: "Minimal" },
              { value: "technical", label: "Technical" },
              { value: "custom", label: "Custom" },
            ]}
          />
        </Field>
        {settings.personality === "custom" && (
          <TextArea
            placeholder="Describe how BEV should talk, e.g. 'dry, deadpan, very brief'."
            value={settings.customPersonality}
            onChange={(e) => update({ customPersonality: e.target.value })}
          />
        )}
        <Field label="Response length">
          <Select
            ariaLabel="Response length"
            value={settings.responseLength}
            onChange={(responseLength) => update({ responseLength: responseLength as typeof settings.responseLength })}
            options={[
              { value: "short", label: "Short (spoken-friendly)" },
              { value: "normal", label: "Normal" },
              { value: "detailed", label: "Detailed" },
            ]}
          />
        </Field>
        <Field label="Gaming quiet mode" hint="Minimal replies while you game. BEV can also toggle this by voice.">
          <Toggle label="Quiet mode" checked={settings.gamingQuietMode} onChange={(gamingQuietMode) => update({ gamingQuietMode })} />
        </Field>
      </Section>

      <Section title="Proactive monitoring">
        <Field label="Enable alerts" hint="BEV watches CPU/RAM and notifies you when a threshold is crossed. Off by default.">
          <Toggle label="Proactive monitoring" checked={settings.proactiveMonitoring} onChange={(proactiveMonitoring) => update({ proactiveMonitoring })} />
        </Field>
        {settings.proactiveMonitoring && (
          <>
            <Field label="CPU alert threshold">
              <Slider ariaLabel="CPU threshold" min={50} max={100} value={settings.cpuAlertPercent} onChange={(cpuAlertPercent) => update({ cpuAlertPercent })} format={(v) => `${v}%`} />
            </Field>
            <Field label="RAM alert threshold">
              <Slider ariaLabel="RAM threshold" min={50} max={100} value={settings.ramAlertPercent} onChange={(ramAlertPercent) => update({ ramAlertPercent })} format={(v) => `${v}%`} />
            </Field>
          </>
        )}
      </Section>

      <Section title="Diagnostics">
        <Field label="Version">
          <span className="font-mono text-sm text-slate-300">BEV {version}</span>
        </Field>
        <div className="flex justify-end">
          <Button variant="danger" onClick={() => setConfirmReset(true)}>
            Reset all settings
          </Button>
        </div>
      </Section>

      {confirmReset && (
        <ConfirmDialog
          text="Reset every setting to defaults? Your memories, routines and API keys are kept."
          confirmLabel="Reset"
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            await reset();
            setConfirmReset(false);
          }}
        />
      )}
    </div>
  );
}

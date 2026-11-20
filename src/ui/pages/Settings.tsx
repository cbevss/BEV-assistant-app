import { useEffect, useState } from "react";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { useSettings, Personality } from "@/state/settings";
import { PageHeader, Section, Field, Select, Slider, Toggle, TextArea, TextInput, Button } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AppsIndex } from "../components/AppsIndex";
import { DataControls } from "../components/DataControls";
import { applyAppearance } from "@/lib/appearance";

export function Settings({ part = "general" }: { part?: "general" | "apps" | "advanced" }) {
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
      {part === "apps" && (
        <>
          <PageHeader title="Apps" subtitle="The installed apps BEV knows how to open. It rescans by itself when you ask for something new." />
          <AppsIndex />
        </>
      )}
      {part === "general" && (
        <>
      <PageHeader title="General" subtitle="Startup, BEV's personality, keeping an eye on the PC and your daily briefing." />

      <Section title="Startup & background">
        <Field label="Start BEV with Windows" hint="Launches minimised to the tray on sign-in.">
          <Toggle label="Start with Windows" checked={!!autostart} onChange={toggleAutostart} />
        </Field>
        <Field label="Close to system tray" hint="The ✕ button hides BEV to the tray instead of quitting. Off = ✕ quits BEV.">
          <Toggle label="Close to system tray" checked={settings.closeToTray} onChange={(closeToTray) => update({ closeToTray })} />
        </Field>
        <Field label="Minimize to system tray" hint="The – button hides BEV to the tray instead of the taskbar.">
          <Toggle label="Minimize to system tray" checked={settings.minimizeToTray} onChange={(minimizeToTray) => update({ minimizeToTray })} />
        </Field>
        <Field label="Listen for “BEV” on launch" hint="Starts the microphone wake-word listener automatically. Privacy mode always overrides this.">
          <Toggle label="Listen on startup" checked={settings.listenOnStartup} onChange={(listenOnStartup) => update({ listenOnStartup })} />
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
        <Field label="Call me" hint="What BEV calls you now and then, e.g. “Done, sir.” Leave empty for nothing.">
          <TextInput
            aria-label="What BEV calls you"
            className="w-48"
            maxLength={40}
            placeholder="sir"
            value={settings.addressAs}
            onChange={(e) => update({ addressAs: e.target.value })}
          />
        </Field>
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
        <Field label="Go quiet when a game starts" hint="While a Steam game or any exclusive full-screen game is running, BEV keeps replies short, skips the spoken “Yeah?” and holds back pop-ups, then goes back to normal when you stop.">
          <Toggle label="Automatic gaming mode" checked={settings.autoGamingMode} onChange={(autoGamingMode) => update({ autoGamingMode })} />
        </Field>
        <Field label="Screen time" hint="Counts how long each app is in front while you're at the PC, shown on the Activity page. Stays on this PC.">
          <Toggle label="Screen time" checked={settings.screenTime} onChange={(screenTime) => update({ screenTime })} />
        </Field>
        <Field label="Daily play time nudge" hint="BEV mentions it once a day when your gaming passes this. Play time is on the Activity page.">
          <Select
            ariaLabel="Daily play time nudge"
            className="w-40"
            value={String(settings.playLimitMinutes ?? 0)}
            onChange={(v) => update({ playLimitMinutes: Number(v) || null })}
            options={[{ value: "0", label: "Off" }, ...[60, 90, 120, 180, 240, 300].map((m) => ({ value: String(m), label: m < 120 ? `${m} minutes` : `${m / 60} hours` }))]}
          />
        </Field>
        <Field
          label="Popup during fullscreen games"
          hint="The orb never takes focus from your game. Automatic shows it over borderless and windowed games, and hides it over exclusive fullscreen, where anything drawn on top can knock a game out of fullscreen. BEV still listens and talks either way."
        >
          <Select
            ariaLabel="Popup during fullscreen games"
            value={settings.gamePopup}
            onChange={(gamePopup) => update({ gamePopup: gamePopup as typeof settings.gamePopup })}
            options={[
              { value: "auto", label: "Automatic (recommended)" },
              { value: "hide", label: "Hide it, voice only" },
              { value: "show", label: "Always show it" },
            ]}
          />
        </Field>
      </Section>

      <Section title="Proactive monitoring">
        <Field label="Keep an eye on the PC" hint="BEV notices high CPU or memory, app crashes, the internet dropping and disks filling up, and lets you know. Nothing pops up during a fullscreen game; it waits until afterwards. Off by default.">
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
            <Field label="App crashes and blue screens">
              <Toggle label="Watch for crashes" checked={settings.watch.crashes} onChange={(crashes) => update({ watch: { ...settings.watch, crashes } })} />
            </Field>
            <Field label="Internet dropping out">
              <Toggle label="Watch the internet" checked={settings.watch.network} onChange={(network) => update({ watch: { ...settings.watch, network } })} />
            </Field>
            <Field label="Disks filling up">
              <Toggle label="Watch disk space" checked={settings.watch.disk} onChange={(disk) => update({ watch: { ...settings.watch, disk } })} />
            </Field>
          </>
        )}
      </Section>

      <Section title="Daily briefing">
        <Field label="Time" hint="BEV gathers today's calendar, important email, tasks due and anything wrong with the PC, then tells you. Uses whichever of those you've connected. Leave empty for none.">
          <TextInput type="time" aria-label="Briefing time" value={settings.briefingTime} onChange={(e) => update({ briefingTime: e.target.value })} />
        </Field>
        <Field label="Say it out loud" hint="Spoken if BEV isn't busy and quiet mode is off; it's also in Chat and as a notification.">
          <Toggle label="Speak the briefing" checked={settings.briefingSpoken} onChange={(briefingSpoken) => update({ briefingSpoken })} />
        </Field>
      </Section>

        </>
      )}
      {part === "advanced" && (
        <>
      <PageHeader title="Advanced" subtitle="Version information, your data, and resetting BEV." />
      <Section title="Diagnostics">
        <Field label="Version">
          <span className="font-mono text-sm text-ink-2">BEV {version}</span>
        </Field>
        <Field label="Reset all settings" hint="Puts every setting back to its default. Memories, routines and API keys are kept.">
          <Button variant="danger" onClick={() => setConfirmReset(true)}>
            Reset settings
          </Button>
        </Field>
      </Section>
      <DataControls />
        </>
      )}

      {confirmReset && (
        <ConfirmDialog
          text="Reset every setting to defaults? Your memories, routines and API keys are kept."
          confirmLabel="Reset"
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            await reset();
            applyAppearance(useSettings.getState().settings);
            setConfirmReset(false);
          }}
        />
      )}
    </div>
  );
}

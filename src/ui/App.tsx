import { setFileManagerPref } from "@/lib/native";
import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { useRoutines } from "@/routines/store";
import { startScheduler } from "@/routines/scheduler";
import { needsReindex, indexDocuments } from "@/lib/documents";
import { startGamingWatch, isQuiet } from "@/lib/gaming";
import { useUsage } from "@/ai/usage";
import { startPhoneControl } from "@/account/phone";
import { startBevBotLink } from "@/integrations/bevbot";
import { configureAlerts } from "@/lib/alerts";
import { startTimers } from "@/lib/timers";
import { startWatches } from "@/lib/watches";
import { startPlaytime } from "@/lib/playtime";
import { startFocusClock } from "@/lib/focus";
import { startRoutineHotkeys } from "@/routines/hotkeys";
import { startScreenTime } from "@/lib/screentime";
import { startPowerTimer } from "@/lib/powerTimer";
import { applyAppearance } from "@/lib/appearance";
import { Dashboard } from "./pages/Dashboard";
import { Assistant } from "./pages/Assistant";
import { Automation } from "./pages/Automation";
import { Memory } from "./pages/Memory";
import { Onboarding } from "./pages/Onboarding";
import { AccountGate } from "./account/AccountGate";
import { ApprovalModal } from "./components/ApprovalModal";
import { TitleBar } from "./components/TitleBar";
import { SettingsHub } from "./pages/SettingsHub";
import { Rail } from "./shell/Rail";
import { Core } from "./components/Core";
import { CommandPalette } from "./shell/CommandPalette";
import { SystemBar } from "./shell/SystemBar";
import { pruneHistory, startBrain } from "@/brain/memory";
import { configureBackground } from "@/ai/background";
import { startIntegrations } from "@/integrations/registry";
import { native } from "@/lib/native";
import { configureNotices } from "@/proactive/notices";
import { startWatchers } from "@/proactive/watchers";
import { startBriefings } from "@/proactive/briefing";
import { Orchestrator } from "@/ai/orchestrator";
import { makeAssistantProvider } from "@/ai/factory";
import { notify } from "@/lib/notify";
import { bootstrapVoice, getController, maybeStartListening } from "@/voice/bootstrap";
import { startMonitor } from "@/lib/monitor";
import { CardUnlock } from "./components/CardUnlock";
import { startUpdateChecks } from "../lib/update";
import { startAppScanning } from "../lib/appScan";
import { upgradeStartWithWindows } from "../lib/startup";

interface PendingApproval {
  id: string;
  description: string;
  resolve: (ok: boolean) => void;
}


export function App() {
  const { loaded, settings } = useSettings();
  // Approvals can arrive from voice, chat, routines and the scheduler at once,
  // so they queue: the modal shows the oldest, and every caller gets an answer.
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const pendingApproval = approvals[0] ?? null;
  const [palette, setPalette] = useState(false);
  const privacyMode = useAssistant((a) => a.privacyMode);
  // Pages fade in when you switch area; settings animates its own sections.
  const section = useLocation().pathname.split("/")[1] || "assistant";

  // Screen replay runs only while the user has it on, BEV may look at the
  // screen, and privacy mode is off. Turning it off clears what was kept.
  const replayOn = loaded && settings.screenReplay && settings.toolPermissions.look_back !== false && !privacyMode;
  useEffect(() => {
    native.replayConfigure(replayOn).catch(() => {});
  }, [replayOn]);

  // Ctrl+K anywhere opens search and commands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const answerApproval = (ok: boolean) => {
    const current = approvals[0];
    if (!current) return;
    current.resolve(ok);
    setApprovals((q) => q.filter((a) => a.id !== current.id));
  };

  useEffect(() => {
    // Load persisted state, then wire the assistant once settings are ready.
    (async () => {
      await useSettings.getState().init();
      await useRoutines.getState().init();
      applyAppearance(useSettings.getState().settings);

      // Fire scheduled routines on their own, even while minimised to tray.
      startScheduler();
      startGamingWatch();
      void useUsage.getState().load();
      // Phone control (only runs when switched on and signed in).
      startPhoneControl();
      // The owner's BEV Discord bot: events and "pc …" DMs (only once linked).
      startBevBotLink();
      // Timers, alarms and reminders (local), announced through BEV's voice.
      configureAlerts({ announce: async (t) => (await getController()?.announce(t)) ?? false });
      startTimers();
      startWatches();
      startPlaytime();
      startFocusClock();
      startRoutineHotkeys();
      startScreenTime();
      startPowerTimer();

      // Catch up on documents changed since BEV last read them (in the background).
      {
        const d = useSettings.getState().settings.documents;
        if (needsReindex(d.folders, d.lastIndexed)) setTimeout(() => void indexDocuments().catch(() => {}), 20_000);
      }

      // Register the approval handler the orchestrator calls for sensitive tools.
      // BEV is often hidden in the tray when a voice request needs approval;
      // bring the window up so the prompt isn't waiting where nobody can see it.
      useAssistant.getState().setApprovalHandler(
        (description, signal) =>
          new Promise<boolean>((resolve) => {
            const id = crypto.randomUUID();
            setApprovals((q) => [...q, { id, description, resolve }]);
            // Answered another way (out loud): take the prompt down.
            signal?.addEventListener(
              "abort",
              () => {
                setApprovals((q) => q.filter((a) => a.id !== id));
                resolve(false);
              },
              { once: true }
            );
            const w = getCurrentWindow();
            w.unminimize()
              .then(() => w.show())
              .then(() => w.setFocus())
              .catch(() => {});
          })
      );

      // Proactive: alerts wait while a game is fullscreen or quiet mode is on.
      configureNotices({
        notify: (t, b) => notify(t, b),
        holdBack: async () => isQuiet() || (await native.fullscreenState().catch(() => "none")) !== "none",
      });
      // CPU/RAM alerts, crash/network/disk watchers and the daily briefing.
      startMonitor();
      // Older installs start via the slower Run key: move them to the logon task.
      setTimeout(() => void upgradeStartWithWindows(), 15_000);
      startWatchers();
      startBriefings({
        announce: async (t) => (await getController()?.announce(t)) ?? false,
        toChat: (t) => useAssistant.getState().pushMessage({ role: "assistant", content: t }),
      });

      // Background tasks run in their own orchestrators.
      configureBackground({
        makeProvider: () => makeAssistantProvider(useSettings.getState().settings),
        makeOrchestrator: (p, h) => new Orchestrator(p, h, { background: true }),
        notify: (t, b) => void notify(t, b),
      });

      // Connected services: start the user's MCP servers.
      startIntegrations().catch(() => {});

      // Second brain: trim old history, then fill in semantic-search vectors.
      pruneHistory().catch(() => {});
      startBrain();

      // Wire the full voice vertical slice (shortcut + tray + controller).
      bootstrapVoice().catch(() => {});

      // Updates: look for a newer signed release now and every half hour; the
      // title bar shows a download button when one is ready.
      startUpdateChecks();
      // Folders open in the file manager picked in Settings.
      setFileManagerPref(useSettings.getState().settings.fileManager);
      useSettings.subscribe((s) => setFileManagerPref(s.settings.fileManager));
      // Make the BEV folder (Installers, From phone) so it's there to find and to add to antivirus exclusions.
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("bev_folder")).catch(() => {});

      // Keep the installed-app index fresh (launch scan, scans after downloads).
      startAppScanning();
    })();

  }, []);

  // Hold the UI until settings load, then gate on first-run onboarding.
  if (!loaded) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-canvas">
        <Core state="thinking" size={40} title="Loading BEV" />
      </div>
    );
  }
  if (!settings.onboarded) {
    return (
      <AccountGate>
      <Onboarding
        onDone={async () => {
          await useSettings.getState().update({ onboarded: true });
          // Voice was bootstrapped before setup finished, so start it now
          // rather than leaving BEV deaf until the next launch.
          maybeStartListening();
        }}
      />
      </AccountGate>
    );
  }

  return (
    <AccountGate>
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink">
      <Rail />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TitleBar onSearch={() => setPalette(true)} />
        <div className="min-h-0 flex-1">
          <div key={section} className="h-full animate-page-in">
          <Routes>
            <Route path="/" element={<Navigate to="/assistant" replace />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/activity" element={<Page><Dashboard /></Page>} />
            <Route path="/memory" element={<Page><Memory /></Page>} />
            <Route path="/automations" element={<Page><Automation /></Page>} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/:section" element={<SettingsHub />} />
            {/* Old addresses still work. */}
            <Route path="/chat" element={<Navigate to="/assistant" replace />} />
            <Route path="/dashboard" element={<Navigate to="/activity" replace />} />
            <Route path="/automation" element={<Navigate to="/automations" replace />} />
            <Route path="/voice" element={<Navigate to="/settings/voice" replace />} />
            <Route path="/integrations" element={<Navigate to="/settings/ai" replace />} />
            <Route path="/appearance" element={<Navigate to="/settings/appearance" replace />} />
            <Route path="/security" element={<Navigate to="/settings/privacy" replace />} />
            <Route path="*" element={<Navigate to="/assistant" replace />} />
          </Routes>
          </div>
        </div>
        <SystemBar />
      </main>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <CardUnlock />
      {pendingApproval && (
        <ApprovalModal
          key={pendingApproval.id}
          description={pendingApproval.description}
          remaining={approvals.length - 1}
          onApprove={() => answerApproval(true)}
          onCancel={() => answerApproval(false)}
        />
      )}
    </div>
    </AccountGate>
  );
}

/** Scrolling page body with a comfortable reading width. */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-8 py-7">{children}</div>
    </div>
  );
}

// Close-to-tray: hide instead of quit.
export async function hideToTray() {
  await getCurrentWindow().hide();
}

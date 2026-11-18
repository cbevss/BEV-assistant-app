import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { useRoutines } from "@/routines/store";
import { startScheduler } from "@/routines/scheduler";
import { applyAppearance } from "@/lib/appearance";
import { Dashboard } from "./pages/Dashboard";
import { Assistant } from "./pages/Assistant";
import { Automation } from "./pages/Automation";
import { Memory } from "./pages/Memory";
import { Onboarding } from "./pages/Onboarding";
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
import { makeProvider } from "@/ai/factory";
import { notify } from "@/lib/notify";
import { bootstrapVoice, getController, maybeStartListening } from "@/voice/bootstrap";
import { startMonitor } from "@/lib/monitor";
import { check } from "@tauri-apps/plugin-updater";

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
    native.replayConfigure(replayOn, settings.screenReplaySecs).catch(() => {});
  }, [replayOn, settings.screenReplaySecs]);

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

      // Register the approval handler the orchestrator calls for sensitive tools.
      // BEV is often hidden in the tray when a voice request needs approval;
      // bring the window up so the prompt isn't waiting where nobody can see it.
      useAssistant.getState().setApprovalHandler(
        (description) =>
          new Promise<boolean>((resolve) => {
            setApprovals((q) => [...q, { id: crypto.randomUUID(), description, resolve }]);
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
        holdBack: async () => useSettings.getState().settings.gamingQuietMode || (await native.fullscreenState().catch(() => "none")) !== "none",
      });
      // CPU/RAM alerts, crash/network/disk watchers and the daily briefing.
      startMonitor();
      startWatchers();
      startBriefings({
        announce: async (t) => (await getController()?.announce(t)) ?? false,
        toChat: (t) => useAssistant.getState().pushMessage({ role: "assistant", content: t }),
      });

      // Background tasks run in their own orchestrators.
      configureBackground({
        makeProvider: () => makeProvider(useSettings.getState().settings),
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

      // Background auto-update: silently stage any newer signed release so it
      // applies on next launch. No-op when offline or no release is published.
      check()
        .then((u) => u?.downloadAndInstall())
        .catch(() => {});
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
      <Onboarding
        onDone={async () => {
          await useSettings.getState().update({ onboarded: true });
          // Voice was bootstrapped before setup finished, so start it now
          // rather than leaving BEV deaf until the next launch.
          maybeStartListening();
        }}
      />
    );
  }

  return (
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

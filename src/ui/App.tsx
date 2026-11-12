import { useEffect, useState } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { useRoutines } from "@/routines/store";
import { startScheduler } from "@/routines/scheduler";
import { applyAppearance } from "@/lib/appearance";
import { Dashboard } from "./pages/Dashboard";
import { Chat } from "./pages/Chat";
import { Automation } from "./pages/Automation";
import { Memory } from "./pages/Memory";
import { VoiceAudio } from "./pages/VoiceAudio";
import { Integrations } from "./pages/Integrations";
import { Appearance } from "./pages/Appearance";
import { Security } from "./pages/Security";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { ApprovalModal } from "./components/ApprovalModal";
import { TitleBar } from "./components/TitleBar";
import { bootstrapVoice, getController } from "@/voice/bootstrap";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: "◎" },
  { to: "/chat", label: "AI Chat", icon: "✦" },
  { to: "/automation", label: "Automation", icon: "⚙" },
  { to: "/memory", label: "Memory", icon: "❖" },
  { to: "/voice", label: "Voice & Audio", icon: "🎙" },
  { to: "/integrations", label: "Integrations", icon: "⌁" },
  { to: "/appearance", label: "Appearance", icon: "✧" },
  { to: "/security", label: "Security", icon: "⛉" },
  { to: "/settings", label: "Settings", icon: "⋄" },
];

export function App() {
  const { micEnabled, privacyMode, state } = useAssistant();
  const { loaded, settings } = useSettings();
  const [pendingApproval, setPendingApproval] = useState<{
    description: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  useEffect(() => {
    // Load persisted state, then wire the assistant once settings are ready.
    (async () => {
      await useSettings.getState().init();
      await useRoutines.getState().init();
      applyAppearance(useSettings.getState().settings);

      // Fire scheduled routines on their own, even while minimised to tray.
      startScheduler();

      // Register the approval handler the orchestrator calls for sensitive tools.
      useAssistant.getState().setApprovalHandler(
        (description) =>
          new Promise<boolean>((resolve) => setPendingApproval({ description, resolve }))
      );

      // Wire the full voice vertical slice (shortcut + tray + controller).
      bootstrapVoice().catch(() => {});
    })();

    const un = listen("tray://privacy-mode", () => {
      useAssistant.getState().setPrivacyMode(true);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Hold the UI until settings load, then gate on first-run onboarding.
  if (!loaded) {
    return <div className="grid h-screen w-screen place-items-center text-slate-500">Loading BEV…</div>;
  }
  if (!settings.onboarded) {
    return <Onboarding onDone={() => useSettings.getState().update({ onboarded: true })} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden text-slate-100">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col glass border-r border-white/5">
        <div className="drag flex items-center gap-2 px-5 py-5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-bev-cyan to-bev-violet font-bold text-black shadow-glow">
            B
          </div>
          <div>
            <div className="text-lg font-semibold tracking-wide text-glow">BEV</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400">
              assistant online
            </div>
          </div>
        </div>
        <nav className="no-drag flex-1 space-y-1 px-3 py-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? "bg-bev-cyan/15 text-bev-cyan shadow-glow"
                    : "text-slate-300 hover:bg-white/5"
                }`
              }
            >
              <span className="w-4 text-center opacity-80">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <button
          className="no-drag m-3 flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-slate-400 transition hover:bg-white/5"
          onClick={() => {
            const c = getController();
            if (!c) return;
            if (privacyMode) {
              useAssistant.getState().setPrivacyMode(false);
              c.enableListening();
            } else if (micEnabled) c.disableListening();
            else c.enableListening();
          }}
          title={micEnabled ? "Click to stop listening" : "Click to start listening for “BEV”"}
        >
          <StatusDot on={micEnabled && !privacyMode} />
          <span className="flex-1">
            {privacyMode ? "Privacy mode — mic off" : micEnabled ? "Listening for “BEV”" : "Mic off — click to listen"}
            <span className="mt-0.5 block text-[10px] text-slate-500">
              {state} · Ctrl+Alt+B to talk
            </span>
          </span>
        </button>
      </aside>

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <TitleBar />
        <div className="flex-1 overflow-y-auto p-6">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/automation" element={<Automation />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/voice" element={<VoiceAudio />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/appearance" element={<Appearance />} />
            <Route path="/security" element={<Security />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>

      {pendingApproval && (
        <ApprovalModal
          description={pendingApproval.description}
          onApprove={() => {
            pendingApproval.resolve(true);
            setPendingApproval(null);
          }}
          onCancel={() => {
            pendingApproval.resolve(false);
            setPendingApproval(null);
          }}
        />
      )}
    </div>
  );
}

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={`mr-2 inline-block h-2 w-2 rounded-full ${
        on ? "bg-bev-ok shadow-glow" : "bg-slate-600"
      }`}
    />
  );
}

// Close-to-tray: hide instead of quit.
export async function hideToTray() {
  await getCurrentWindow().hide();
}

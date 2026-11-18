import "./tauri-mock";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "../styles.css";
import { useAssistant } from "@/state/assistant";

// Optional state for screenshots: ?state=listening&chat=1
const p = new URLSearchParams(location.search);
const { App } = await import("../ui/App");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <HashRouter>
    <App />
  </HashRouter>
);
setTimeout(() => {
  const st = p.get("state");
  if (st) useAssistant.setState({ state: st as never, statusText: "", micEnabled: true });
  if (p.get("palette")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  if (p.get("approval")) useAssistant.getState().requestApproval?.("BEV wants to delete 3 files in Downloads.");
  if (p.get("chat")) {
    const push = useAssistant.getState().pushMessage;
    push({ role: "user", content: "Open Spotify and play my liked songs, then turn the volume down a bit" });
    push({ role: "tool", content: "Opened Spotify", toolName: "launch_app", ok: true } as never);
    push({ role: "tool", content: "Playing your Liked Songs.", toolName: "spotify_play", ok: true } as never);
    push({ role: "assistant", content: "Done. Liked Songs is playing in Spotify and I've brought the volume down to 30%." });
    push({ role: "user", content: "What's using my RAM?" });
    push({ role: "tool", content: "chrome.exe 2.3 GB\nDiscord.exe 640 MB", toolName: "get_running_apps", ok: true } as never);
    push({ role: "tool", content: "error: diagnostics timed out", toolName: "diagnose_pc", ok: false } as never);
    push({ role: "assistant", content: "**Chrome** is using the most, about **2.3 GB** across its tabs. Next is Discord at 640 MB.\n\n- Closing unused Chrome tabs would free the most\n- Your total is 11 GB of 32 GB, so nothing is urgent" });
  }
}, 600);

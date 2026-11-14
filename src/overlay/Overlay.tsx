import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { Orb } from "./Orb";
import { useAssistant, AssistantState } from "@/state/assistant";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";

const stateLabel: Record<AssistantState, string> = {
  idle: "",
  activating: "Waking…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  executing: "Working on it",
  completed: "Done",
  error: "Something went wrong",
};

/**
 * The floating overlay: just the orb, translucent, on a transparent window
 * (plus a caption for errors). It listens for
 * backend events (wake, state changes) and makes itself click-through except
 * when it needs interaction.
 */
export function Overlay() {
  const { state, audioLevel, statusText } = useAssistant();
  const { accent, reducedMotion, overlayScale } = useSettings((s) => s.settings);
  const expanded = state !== "idle";

  useEffect(() => {
    // Backend wake-word / voice pipeline drives these events.
    const unsubs: Array<Promise<() => void>> = [
      listen<AssistantState>("bev://state", (e) => {
        useAssistant.getState().setState(e.payload);
      }),
      listen<number>("bev://audio-level", (e) => {
        useAssistant.getState().setAudioLevel(e.payload);
      }),
      listen<string>("bev://status", (e) => {
        useAssistant.setState((s) => ({ ...s, statusText: e.payload }));
      }),
    ];
    return () => {
      unsubs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  useEffect(() => {
    // The overlay only displays the orb; nothing in it is clickable. Keep it
    // click-through in every state so whatever is behind it stays usable.
    native.setOverlayClickthrough(true).catch(() => {});
  }, [expanded]);

  return (
    <div
      className="h-screen w-screen grid place-items-center overflow-hidden"
      style={{ transform: `scale(${overlayScale})`, transformOrigin: "center" }}
    >
      <AnimatePresence mode="wait">
        {!expanded ? (
          <motion.div
            key="idle"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            className="relative"
          >
            {/* Small idle indicator — subtle breathing dot. */}
            <motion.div
              className="h-5 w-5 rounded-full"
              style={{ background: accent, boxShadow: `0 0 24px ${accent}88` }}
              animate={reducedMotion ? { opacity: 0.8 } : { opacity: [0.4, 1, 0.4], scale: [0.9, 1.05, 0.9] }}
              transition={{ repeat: Infinity, duration: 2.6, ease: "easeInOut" }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ opacity: 0, scale: 0.85 }}
            // Translucent: the desktop shows through the orb.
            animate={{ opacity: 0.9, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ type: "spring", stiffness: 180, damping: 22 }}
            className="relative grid place-items-center"
            title={statusText || stateLabel[state]}
          >
            <Orb state={state} level={audioLevel} accentOverride={accent} reducedMotion={reducedMotion} />
            {/* Only the symbol, except for errors: those are only ever shown
                here, so say what went wrong (plain text, no panel). */}
            {state === "error" && (
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute top-full mt-1 max-w-[380px] text-center text-sm font-semibold text-rose-100"
                // A dark outline keeps it readable over any wallpaper or window, without a panel.
                style={{
                  textShadow:
                    "0 0 2px #000, 0 0 2px #000, 0 1px 3px rgba(0,0,0,0.95), 0 0 14px rgba(0,0,0,0.75)",
                }}
              >
                {statusText || stateLabel.error}
              </motion.p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

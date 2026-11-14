import { create } from "zustand";

/** The eight canonical assistant states that drive overlay animation. */
export type AssistantState =
  | "idle"
  | "activating"
  | "listening"
  | "thinking"
  | "speaking"
  | "executing"
  | "completed"
  | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  ok?: boolean;
  at: number;
}

interface AssistantStore {
  state: AssistantState;
  /** Live audio level 0..1, fed from the mic (listening) or TTS (speaking). */
  audioLevel: number;
  micEnabled: boolean;
  privacyMode: boolean;
  statusText: string;
  messages: ChatMessage[];
  /** Which wake engine is listening, and a note if it isn't the chosen one. */
  wake: { engine: "speech" | "on-device"; note: string | null } | null;

  /** Set by the UI to route sensitive-tool approvals through a modal. */
  requestApproval?: (description: string) => Promise<boolean>;
  setApprovalHandler: (fn: (description: string) => Promise<boolean>) => void;

  setState: (s: AssistantState, statusText?: string) => void;
  setAudioLevel: (v: number) => void;
  setMic: (on: boolean) => void;
  setPrivacyMode: (on: boolean) => void;
  setWake: (w: AssistantStore["wake"]) => void;
  pushMessage: (m: Omit<ChatMessage, "id" | "at"> & Partial<Pick<ChatMessage, "id" | "at">>) => void;
  clearMessages: () => void;
}

export const useAssistant = create<AssistantStore>((set) => ({
  state: "idle",
  audioLevel: 0,
  micEnabled: false,
  privacyMode: false,
  statusText: "",
  messages: [],
  wake: null,

  setApprovalHandler: (fn) => set({ requestApproval: fn }),
  setState: (state, statusText) =>
    set((s) => ({ state, statusText: statusText ?? s.statusText })),
  setAudioLevel: (audioLevel) => set({ audioLevel }),
  setWake: (wake) => set({ wake }),
  setMic: (micEnabled) => set({ micEnabled }),
  setPrivacyMode: (privacyMode) =>
    // Privacy mode forces the mic off; leaving it on is the user's explicit act.
    set((s) => ({ privacyMode, micEnabled: privacyMode ? false : s.micEnabled })),
  pushMessage: (m) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: m.id ?? crypto.randomUUID(), at: m.at ?? Date.now(), ...m },
      ],
    })),
  clearMessages: () => set({ messages: [] }),
}));

/** Accent colour per state — consumed by the overlay orb + rings. */
export const stateAccent: Record<AssistantState, string> = {
  idle: "#22d3ee",
  activating: "#38e8ff",
  listening: "#22d3ee",
  thinking: "#8b5cf6",
  speaking: "#3b82f6",
  executing: "#34d399",
  completed: "#34d399",
  error: "#f43f5e",
};

import { memo } from "react";
import { motion } from "framer-motion";
import { AssistantState, stateAccent } from "@/state/assistant";

interface OrbProps {
  state: AssistantState;
  /** 0..1 live level from mic (listening) or TTS (speaking). */
  level: number;
  /** User accent; replaces the cyan used by idle/activating/listening. */
  accentOverride?: string;
  /** Stops ring rotation and the thinking spinner. */
  reducedMotion?: boolean;
}

const ACCENTED = new Set<AssistantState>(["idle", "activating", "listening"]);

/**
 * The BEV core: a layered holographic orb with rotating rings and a
 * voice-reactive pulse. Scale and glow track `level` so it reacts to real
 * audio rather than a canned loop.
 */
function OrbInner({ state, level, accentOverride, reducedMotion }: OrbProps) {
  const accent = accentOverride && ACCENTED.has(state) ? accentOverride : stateAccent[state];
  const spin = (deg: number) => (reducedMotion ? {} : { rotate: deg });
  const reactive = state === "listening" || state === "speaking";
  const pulse = reactive ? 1 + level * 0.35 : 1;
  const ringSpeed = state === "thinking" ? 2.2 : state === "executing" ? 3.5 : 8;

  return (
    <div className="relative grid place-items-center" style={{ width: 240, height: 240 }}>
      {/* Outer glow halo */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 220,
          height: 220,
          background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
          filter: "blur(12px)",
        }}
        animate={{ scale: pulse * (state === "idle" ? 0.9 : 1.05), opacity: state === "idle" ? 0.5 : 0.9 }}
        transition={{ type: "spring", stiffness: 120, damping: 18 }}
      />

      {/* Rotating outer ring */}
      <motion.svg
        width={220}
        height={220}
        viewBox="0 0 220 220"
        className="absolute"
        animate={spin(360)}
        transition={{ repeat: Infinity, ease: "linear", duration: ringSpeed }}
      >
        <circle
          cx="110"
          cy="110"
          r="96"
          fill="none"
          stroke={accent}
          strokeWidth="1.5"
          strokeOpacity="0.35"
          strokeDasharray="6 10"
        />
      </motion.svg>

      {/* Counter-rotating inner ring */}
      <motion.svg
        width={180}
        height={180}
        viewBox="0 0 180 180"
        className="absolute"
        animate={spin(-360)}
        transition={{ repeat: Infinity, ease: "linear", duration: ringSpeed * 1.6 }}
      >
        <circle
          cx="90"
          cy="90"
          r="74"
          fill="none"
          stroke={accent}
          strokeWidth="1"
          strokeOpacity="0.55"
          strokeDasharray="2 14"
        />
      </motion.svg>

      {/* Core sphere */}
      <motion.div
        className="relative rounded-full"
        style={{
          width: 120,
          height: 120,
          background: `radial-gradient(circle at 35% 30%, ${accent}dd, ${accent}44 55%, #05070d 100%)`,
          boxShadow: `0 0 40px ${accent}66, inset 0 0 30px ${accent}55`,
        }}
        animate={{
          scale: pulse,
          boxShadow: `0 0 ${30 + level * 50}px ${accent}88, inset 0 0 30px ${accent}55`,
        }}
        transition={{ type: "spring", stiffness: 200, damping: 20 }}
      >
        {state === "thinking" && (
          <motion.div
            className="absolute inset-2 rounded-full border-2 border-dashed"
            style={{ borderColor: `${accent}88` }}
            animate={reducedMotion ? { opacity: [0.4, 1, 0.4] } : { rotate: 360 }}
            transition={{ repeat: Infinity, ease: "linear", duration: reducedMotion ? 1.6 : 1.2 }}
          />
        )}
      </motion.div>

      {/* Live waveform ring for listening/speaking */}
      {reactive && <Waveform accent={accent} level={level} />}
    </div>
  );
}

function Waveform({ accent, level }: { accent: string; level: number }) {
  const bars = 48;
  return (
    <svg className="absolute" width={240} height={240} viewBox="0 0 240 240">
      {Array.from({ length: bars }).map((_, i) => {
        const angle = (i / bars) * Math.PI * 2;
        const base = 104;
        // Deterministic-ish variation keyed by index so bars differ but stay stable.
        const jitter = (Math.sin(i * 1.7) + 1) / 2;
        const len = 6 + level * 26 * (0.4 + jitter);
        const x1 = 120 + Math.cos(angle) * base;
        const y1 = 120 + Math.sin(angle) * base;
        const x2 = 120 + Math.cos(angle) * (base + len);
        const y2 = 120 + Math.sin(angle) * (base + len);
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={accent}
            strokeWidth="2"
            strokeLinecap="round"
            strokeOpacity={0.4 + level * 0.5}
          />
        );
      })}
    </svg>
  );
}

export const Orb = memo(OrbInner);

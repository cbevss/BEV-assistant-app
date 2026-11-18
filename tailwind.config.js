/** @type {import('tailwindcss').Config} */
// BEV design tokens. Values live as CSS variables in src/styles.css so the
// accent can be changed at runtime (Appearance); see docs/DESIGN.md.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./overlay.html", "./ui-preview.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: v("canvas"),
        rail: v("rail"),
        surface: { 1: v("surface-1"), 2: v("surface-2"), 3: v("surface-3") },
        line: { subtle: v("line-subtle"), DEFAULT: v("line"), strong: v("line-strong") },
        ink: { DEFAULT: v("ink"), 2: v("ink-2"), 3: v("ink-3"), 4: v("ink-4") },
        accent: { DEFAULT: v("accent"), strong: v("accent-strong"), ink: v("accent-ink") },
        ok: v("ok"),
        warn: v("warn"),
        danger: v("danger"),
        // Neutral scale used across the app: one cool graphite family.
        slate: {
          50: "#F4F6F8",
          100: "#E8ECF1",
          200: "#D3D9E1",
          300: "#B7BFCA",
          400: "#A0A9B6",
          500: "#6D7786",
          600: "#4C5461",
          700: "#2C323B",
          800: "#1B1F26",
          900: "#14171C",
          950: "#0E1014",
        },
        // Legacy names kept so older classes map onto the new system.
        bev: { cyan: v("accent"), blue: v("accent-strong"), violet: v("accent"), glow: v("accent-strong"), danger: v("danger"), ok: v("ok") },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Segoe UI"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', '"Cascadia Mono"', "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "22px" }],
        md: ["15px", { lineHeight: "24px" }],
        lg: ["16px", { lineHeight: "24px", letterSpacing: "-0.005em" }],
        xl: ["20px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["26px", { lineHeight: "32px", letterSpacing: "-0.015em" }],
      },
      borderRadius: { xs: "3px", sm: "4px", DEFAULT: "6px", md: "6px", lg: "8px", xl: "10px", "2xl": "14px" },
      boxShadow: {
        pop: "0 1px 0 rgb(255 255 255 / 0.04) inset, 0 12px 32px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(var(--line))",
        focus: "0 0 0 2px rgb(var(--canvas)), 0 0 0 4px rgb(var(--accent))",
        // Retired effects: kept as names so old classes render nothing.
        glow: "none",
        "glow-lg": "none",
        panel: "0 12px 32px rgb(0 0 0 / 0.5)",
      },
      transitionTimingFunction: { out: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      transitionDuration: { fast: "120ms", base: "180ms" },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "rise-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.98)" }, to: { opacity: "1", transform: "none" } },
        "page-in": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        orbit: { to: { transform: "rotate(360deg)" } },
        breathe: { "0%,100%": { opacity: "0.55" }, "50%": { opacity: "1" } },
      },
      animation: {
        "fade-in": "fade-in 160ms cubic-bezier(0.2,0.8,0.2,1)",
        "rise-in": "rise-in 180ms cubic-bezier(0.2,0.8,0.2,1)",
        "page-in": "page-in 260ms cubic-bezier(0.2,0.8,0.2,1) both",
        "msg-in": "rise-in 240ms cubic-bezier(0.2,0.8,0.2,1) both",
        "scale-in": "scale-in 160ms cubic-bezier(0.2,0.8,0.2,1)",
        orbit: "orbit 1.6s linear infinite",
        breathe: "breathe 2.4s ease-in-out infinite",
        "pulse-slow": "breathe 3s ease-in-out infinite",
        "spin-slow": "orbit 8s linear infinite",
        "spin-rev": "orbit 12s linear infinite reverse",
      },
    },
  },
  plugins: [],
};

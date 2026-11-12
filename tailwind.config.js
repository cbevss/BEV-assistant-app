/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./overlay.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // BEV sci-fi palette — deep charcoal surfaces, cyan/blue/violet light.
        void: "#05070d",
        carbon: "#0a0e17",
        slate: "#111826",
        panel: "rgba(17, 24, 38, 0.72)",
        bev: {
          cyan: "#22d3ee",
          blue: "#3b82f6",
          violet: "#8b5cf6",
          glow: "#38e8ff",
          danger: "#f43f5e",
          ok: "#34d399",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(56, 232, 255, 0.35)",
        "glow-lg": "0 0 60px rgba(56, 232, 255, 0.45)",
        panel: "0 20px 60px rgba(0, 0, 0, 0.6)",
      },
      backdropBlur: { xs: "2px" },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4,0,0.6,1) infinite",
        "spin-slow": "spin 8s linear infinite",
        "spin-rev": "spin 12s linear infinite reverse",
      },
    },
  },
  plugins: [],
};

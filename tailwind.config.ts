import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Prose in the tiles reads as prose, so it gets a proportional face.
        sans: [
          "Helvetica Neue",
          "Helvetica",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Arial",
          "sans-serif",
        ],
        // Anything that has to stay column-aligned — shell commands, tool
        // output, code blocks, the xterm terminal — stays monospace.
        mono: [
          "ui-monospace",
          "SF Mono",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "monospace",
        ],
      },
      colors: {
        // Grok-style dark palette (2026-11-01): pure black, white ink, hairline
        // greys, colour only where it carries meaning.
        bg: {
          base: "#000000",
          panel: "#0A0A0A",
          terminal: "#000000",
          header: "#111111",
          hover: "#1A1A1A",
        },
        edge: {
          DEFAULT: "#262626",
          hi: "#333333",
          accent: "#525252",
        },
        ink: {
          DEFAULT: "#F5F5F5",
          dim: "#D4D4D4",
          muted: "#A3A3A3",
          faint: "#737373",
        },
        term: {
          green: "#4ADE80",
          amber: "#FBBF24",
          cyan: "#67E8F9",
          violet: "#F5F5F5",
          pink: "#F472B6",
          red: "#F87171",
          git: "#FBBF24",
          user: "#A3E635",
        },
      },
      boxShadow: {
        tile: "0 0 0 1px #262626",
        tileHover: "0 0 0 1px #333333",
        glow: "none",
      },
      animation: {
        "pulse-soft": "pulseSoft 2.4s ease-in-out infinite",
        "fade-in": "fadeIn 400ms ease-out both",
        "slide-up": "slideUp 400ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        blink: "blink 1s step-end infinite",
      },
      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.92)" },
        },
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: { "0%, 50%": { opacity: "1" }, "50.01%, 100%": { opacity: "0" } },
      },
    },
  },
  plugins: [],
};

export default config;

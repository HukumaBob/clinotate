import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        "label-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(59, 130, 246, 0)" },
          "25%": { boxShadow: "0 0 0 4px rgba(59, 130, 246, 0.6)" },
        },
      },
      animation: {
        "label-pulse": "label-pulse 700ms ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;

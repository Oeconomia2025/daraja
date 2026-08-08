/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "crypto-dark": "#0a0a0f",
        "crypto-card": "#121315",
        "crypto-border": "#2a2d35",
        "crypto-blue": "#00d4ff",
        "crypto-pink": "#ff00ff",
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0a0a",
        surface: "#161616",
        muted: "#9ca3af",
        accent: "#3b82f6",
      },
    },
  },
  plugins: [],
};

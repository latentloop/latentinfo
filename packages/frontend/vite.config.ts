import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9821",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:9821",
        changeOrigin: true,
      },
    },
  },
  define:
    mode === "development"
      ? { "process.env.NODE_ENV": JSON.stringify("development") }
      : {},
  build: {
    outDir: "dist",
    minify: mode === "production",
    sourcemap: mode === "development",
  },
}));

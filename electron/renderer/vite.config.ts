import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/_web"),
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
    "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(process.env.NEXT_PUBLIC_API_URL ?? ""),
    "process.env.NEXT_PUBLIC_ENABLE_WEB_CLIPPER": JSON.stringify(process.env.NEXT_PUBLIC_ENABLE_WEB_CLIPPER ?? ""),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { port: 5173 },
});

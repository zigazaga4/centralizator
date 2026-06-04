import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The mobile app shares the scan-batch client with the rest of the repo
// (../shared). The alias + fs.allow let Vite resolve and serve it from
// outside the package root.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": path.resolve(__dirname, "../shared") },
  },
  server: {
    host: true,
    fs: { allow: [path.resolve(__dirname, "..")] },
  },
});

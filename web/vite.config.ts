import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// `@tutor/shared` is aliased straight to its TS source so the web app and the
// functions share one type definition with no build step in between.
export default defineConfig({
  // Served at "/" on Firebase Hosting; set VITE_BASE to "/<repo>/" for GitHub Pages.
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@tutor/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendor code out of the app chunk so
        // it caches independently and the app bundle stays lean.
        manualChunks: {
          firebase: [
            "firebase/app",
            "firebase/auth",
            "firebase/firestore",
            "firebase/functions",
            "firebase/storage",
          ],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});

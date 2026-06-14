import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// `@tutor/shared` is aliased straight to its TS source so the web app and the
// functions share one type definition with no build step in between.
export default defineConfig({
  // Served at "/" on Firebase Hosting; set VITE_BASE to "/<repo>/" for GitHub Pages.
  base: process.env.VITE_BASE || "/",
  plugins: [
    react(),
    // Installable, offline-capable PWA. Auto-update so a redeploy silently swaps
    // the service worker on the next visit (paired with registerSW in main.tsx).
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png", "icon.svg"],
      manifest: {
        name: "Tutor — adaptive Obsidian tutor",
        short_name: "Tutor",
        description:
          "Turn your Obsidian vault into an adaptive tutor — concepts, mastery tracking, flashcards, and practice exams.",
        // Brand: paper background (#faf9f6 = rgb(250 249 246)) from index.css.
        theme_color: "#faf9f6",
        background_color: "#faf9f6",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache the built app shell + all static assets so the app loads
        // offline. Firestore/callable traffic is NOT cached here — offline reads
        // are handled by Firestore's own persistent IndexedDB cache (firebase.ts).
        globPatterns: ["**/*.{js,css,html,woff2,svg,png,ico,webmanifest}"],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
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
          // The markdown/math/highlight stack is large and changes rarely;
          // isolating it keeps it out of the entry chunk and lets it cache
          // independently across app deploys.
          markdown: [
            "react-markdown",
            "remark-gfm",
            "remark-math",
            "rehype-katex",
            "rehype-highlight",
            "katex",
            "lowlight",
            "highlight.js",
          ],
        },
      },
    },
  },
});

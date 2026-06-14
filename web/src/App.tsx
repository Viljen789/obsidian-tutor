/**
 * The routed application. Auth is handled at the top: while resolving we show a
 * calm loading state; signed-out users get the sign-in screen; signed-in users
 * get the full app shell with nested routes.
 *
 *   /                       Dashboard — what's due, mastery overview, CTAs
 *   /import                 Vault import (upload .zip -> ingestVault)
 *   /learn, /learn/:id      Learn mode (accent / indigo)
 *   /review, /review/:id    Review mode (review / amber)
 *   /progress               Per-concept mastery + spaced-repetition state
 */
import { lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { SignIn } from "@/views/SignIn";
import { Dashboard } from "@/views/Dashboard";
import { VaultImport } from "@/views/VaultImport";
import { Progress } from "@/views/Progress";
import { Button } from "@/components/ui";

// Lesson-flow + secondary routes are lazy so the markdown/katex/highlight stack
// (now its own vendor chunk), the force-graph, and these views load on
// navigation rather than at startup. The Suspense boundary lives in AppShell.
const Learn = lazy(() => import("@/views/Learn").then((m) => ({ default: m.Learn })));
const Review = lazy(() => import("@/views/Review").then((m) => ({ default: m.Review })));
const Flashcards = lazy(() => import("@/views/Flashcards").then((m) => ({ default: m.Flashcards })));
const Drill = lazy(() => import("@/views/Drill").then((m) => ({ default: m.Drill })));
const Mock = lazy(() => import("@/views/Mock").then((m) => ({ default: m.Mock })));
const CheatSheet = lazy(() => import("@/views/CheatSheet").then((m) => ({ default: m.CheatSheet })));
const Synthesis = lazy(() => import("@/views/Synthesis").then((m) => ({ default: m.Synthesis })));
const Settings = lazy(() => import("@/views/Settings").then((m) => ({ default: m.Settings })));
const Graph = lazy(() => import("@/views/Graph").then((m) => ({ default: m.Graph })));
const Exam = lazy(() => import("@/views/Exam").then((m) => ({ default: m.Exam })));
const ShareView = lazy(() => import("@/views/ShareView").then((m) => ({ default: m.ShareView })));

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <span className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </span>
      </div>
    );
  }

  return (
    <Routes>
      {/* Public — a read-only shared deck, viewable without signing in. */}
      <Route path="share/:shareId" element={<ShareView />} />
      {user ? (
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="import" element={<VaultImport />} />
          <Route path="learn" element={<Learn />} />
          <Route path="learn/:conceptId" element={<Learn />} />
          <Route path="review" element={<Review />} />
          <Route path="review/:conceptId" element={<Review />} />
          <Route path="flashcards" element={<Flashcards />} />
          <Route path="flashcards/:conceptId" element={<Flashcards />} />
          <Route path="drill" element={<Drill />} />
          <Route path="progress" element={<Progress />} />
          <Route path="graph" element={<Graph />} />
          <Route path="exam" element={<Exam />} />
          <Route path="exam/:subject" element={<Exam />} />
          <Route path="mock" element={<Mock />} />
          <Route path="cheatsheet" element={<CheatSheet />} />
          <Route path="cheatsheet/:subject" element={<CheatSheet />} />
          <Route path="synthesis" element={<Synthesis />} />
          <Route path="synthesis/:subject" element={<Synthesis />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      ) : (
        <Route path="*" element={<SignIn />} />
      )}
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="animate-fade py-16 text-center">
      <h1 className="font-serif text-3xl text-ink">Lost the thread</h1>
      <p className="mt-2 text-sm text-muted">That page doesn't exist.</p>
      <Button
        variant="secondary"
        tone="neutral"
        className="mt-6"
        onClick={() => {
          window.location.href = "/";
        }}
      >
        Back to dashboard
      </Button>
    </div>
  );
}

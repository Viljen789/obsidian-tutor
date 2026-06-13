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
import { Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { SignIn } from "@/views/SignIn";
import { Dashboard } from "@/views/Dashboard";
import { VaultImport } from "@/views/VaultImport";
import { Learn } from "@/views/Learn";
import { Review } from "@/views/Review";
import { Progress } from "@/views/Progress";
import { Button } from "@/components/ui";

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

  if (!user) return <SignIn />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="import" element={<VaultImport />} />
        <Route path="learn" element={<Learn />} />
        <Route path="learn/:conceptId" element={<Learn />} />
        <Route path="review" element={<Review />} />
        <Route path="review/:conceptId" element={<Review />} />
        <Route path="progress" element={<Progress />} />
        <Route path="*" element={<NotFound />} />
      </Route>
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

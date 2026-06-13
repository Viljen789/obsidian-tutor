/**
 * Signed-out landing. A single calm panel — product mark, a one-line promise,
 * and Google sign-in. Mirrors the reading-room aesthetic of the app itself so
 * the first impression isn't a generic auth wall.
 */
import { useState } from "react";
import { BookOpen } from "lucide-react";
import { useAuth } from "../lib/auth";
import { backendReady } from "../lib/firebase";
import { Button } from "../components/ui";

export function SignIn() {
  const { signIn } = useAuth();
  const [error, setError] = useState(false);

  const onSignIn = async () => {
    setError(false);
    try {
      await signIn();
    } catch {
      setError(true);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-6">
      <div className="animate-rise w-full max-w-sm text-center">
        <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 text-accent">
          <BookOpen size={26} />
        </div>
        <h1 className="font-serif text-[2rem] leading-tight tracking-tight text-ink">
          Your vault, taught back to you
        </h1>
        <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-muted">
          Import your Obsidian notes and learn them one concept at a time —
          explained, questioned, and spaced for memory.
        </p>
        <Button
          onClick={() => void onSignIn()}
          disabled={!backendReady}
          className="mt-7 w-full"
        >
          Continue with Google
        </Button>
        {error && (
          <p className="mt-3 text-sm text-muted">
            Sign-in didn't complete. Please try again.
          </p>
        )}
        {!backendReady && (
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Live preview — this static deployment has no backend connected.
            Run it locally with the Firebase emulator, or deploy to Firebase
            Hosting to sign in and import a vault.
          </p>
        )}
        <p className="mt-8 text-xs leading-relaxed text-muted/80">
          A calm, focused space for deliberate practice. No noise, no streaks to
          chase — just your material and steady progress.
        </p>
      </div>
    </div>
  );
}

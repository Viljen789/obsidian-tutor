/**
 * Vault import. The client uploads a .zip of an Obsidian vault to Cloud Storage
 * at users/{uid}/uploads/<name>.zip (per CONTRACTS.md §2 storage scoping), then
 * calls api.ingestVault({ storagePath }). Ingestion is idempotent — re-importing
 * upserts concepts by id and never touches mastery — so it doubles as the
 * "import more" entry point. We show a friendly first-time framing, a clear
 * upload affordance, live progress, and a result summary (concept count,
 * subjects, and any non-fatal warnings).
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileArchive,
  Library,
  Upload,
  X,
} from "lucide-react";
import type { IngestVaultResponse } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { api } from "../lib/api";
import { storage } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { qk } from "../lib/firestore-hooks";
import { fileSize } from "../lib/format";
import {
  Button,
  Card,
  ErrorState,
  Eyebrow,
  Pill,
  SubjectDot,
} from "../components/ui";

type Phase = "idle" | "uploading" | "ingesting" | "done" | "error";

export function VaultImport() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<IngestVaultResponse | null>(null);

  const busy = phase === "uploading" || phase === "ingesting";

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".zip")) {
      setErrorMsg("Please choose a .zip of your vault.");
      setPhase("error");
      return;
    }
    setFile(f);
    setErrorMsg(null);
    setPhase("idle");
    setResult(null);
  };

  const onImport = async () => {
    if (!file || !user) return;
    setPhase("uploading");
    setErrorMsg(null);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${paths.user(user.uid)}/uploads/${Date.now()}_${safeName}`;
      await uploadBytes(storageRef(storage, path), file);

      setPhase("ingesting");
      const res = await api.ingestVault({ storagePath: path });
      setResult(res);
      setPhase("done");
      // New concepts/mastery now exist server-side — refresh the caches.
      void qc.invalidateQueries({ queryKey: qk.concepts(user.uid) });
      void qc.invalidateQueries({ queryKey: qk.mastery(user.uid) });
    } catch (e) {
      setErrorMsg(
        e instanceof Error && e.message
          ? friendlyError(e.message)
          : "The import didn't complete. Please try again.",
      );
      setPhase("error");
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setErrorMsg(null);
    setPhase("idle");
  };

  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone="accent">Import</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Bring in your vault
        </h1>
        <p className="mt-1 max-w-lg text-[0.95rem] leading-relaxed text-muted">
          Export your Obsidian vault as a .zip and drop it here. The tutor reads
          your notes, links them into a concept graph, and gets ready to teach.
          Re-importing later updates your notes without losing progress.
        </p>
      </header>

      {phase === "done" && result ? (
        <ResultPanel result={result} onAgain={reset} onStart={() => navigate("/")} />
      ) : (
        <>
          {/* Dropzone */}
          <Card
            className={
              "border-dashed transition-colors " +
              (dragging ? "border-accent bg-accent/[0.03]" : "")
            }
          >
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (!busy) pickFile(e.dataTransfer.files?.[0]);
              }}
              className="flex flex-col items-center px-6 py-12 text-center"
            >
              {file ? (
                <div className="flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-bg/50 p-3.5 text-left">
                  <FileArchive size={20} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{file.name}</p>
                    <p className="text-xs text-muted">{fileSize(file.size)}</p>
                  </div>
                  {!busy && (
                    <button
                      onClick={reset}
                      className="rounded-lg p-1 text-muted transition-colors hover:bg-ink/[0.05] hover:text-ink"
                      title="Remove"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
                    <Upload size={22} />
                  </div>
                  <p className="text-[0.95rem] font-medium text-ink">
                    Drag a .zip here, or
                    <button
                      onClick={() => inputRef.current?.click()}
                      className="ml-1 text-accent underline-offset-2 hover:underline"
                    >
                      browse your files
                    </button>
                  </p>
                  <p className="mt-1 text-xs text-muted">Up to 50 MB</p>
                </>
              )}

              <input
                ref={inputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
            </div>
          </Card>

          {phase === "error" && errorMsg && (
            <Card>
              <ErrorState
                title="Import failed"
                description={errorMsg}
                onRetry={file ? () => void onImport() : undefined}
              />
            </Card>
          )}

          {/* Action + live progress */}
          <div className="flex items-center gap-3">
            <Button
              icon={Upload}
              disabled={!file}
              loading={busy}
              onClick={() => void onImport()}
            >
              {phase === "uploading"
                ? "Uploading…"
                : phase === "ingesting"
                  ? "Reading your notes…"
                  : "Import vault"}
            </Button>
            {busy && (
              <span className="text-sm text-muted">
                {phase === "uploading"
                  ? "Sending your file securely."
                  : "Building the concept graph — this can take a moment."}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ResultPanel({
  result,
  onAgain,
  onStart,
}: {
  result: IngestVaultResponse;
  onAgain: () => void;
  onStart: () => void;
}) {
  return (
    <div className="animate-rise space-y-5">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={20} />
          </div>
          <div>
            <h2 className="font-serif text-xl text-ink">Your vault is ready</h2>
            <p className="mt-1 text-sm text-muted">
              Imported{" "}
              <span className="font-medium text-ink">
                {result.conceptCount} concept{result.conceptCount === 1 ? "" : "s"}
              </span>{" "}
              across {result.subjects.length} subject
              {result.subjects.length === 1 ? "" : "s"}.
            </p>
          </div>
        </div>

        {result.subjects.length > 0 && (
          <div className="mt-5">
            <Eyebrow>Subjects</Eyebrow>
            <div className="mt-2 flex flex-wrap gap-2">
              {result.subjects.map((s) => (
                <Pill key={s} tone="neutral">
                  <SubjectDot subject={s} /> {s}
                </Pill>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2.5">
          <Button icon={ArrowRight} onClick={onStart}>
            Go to dashboard
          </Button>
          <Button variant="secondary" tone="neutral" icon={Library} onClick={onAgain}>
            Import another
          </Button>
        </div>
      </Card>

      {result.warnings.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-review" />
            <Eyebrow tone="review">
              {result.warnings.length} note{result.warnings.length === 1 ? "" : "s"} to review
            </Eyebrow>
          </div>
          <p className="mt-2 text-sm text-muted">
            These didn't stop the import — usually unresolved links or notes
            without frontmatter.
          </p>
          <ul className="mt-3 max-h-48 space-y-1.5 overflow-auto">
            {result.warnings.map((w, i) => (
              <li key={i} className="text-sm leading-relaxed text-muted">
                · {w}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Soften the most common callable error messages into human language. */
function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("unauthenticated")) return "Your session expired. Sign in again and retry.";
  if (m.includes("permission") || m.includes("denied"))
    return "That upload location was refused. Try signing out and back in.";
  if (m.includes("not-found") || m.includes("no such"))
    return "The uploaded file couldn't be found on the server. Please re-upload.";
  if (m.includes("deadline") || m.includes("timeout"))
    return "The import took too long. A smaller vault, or another try, should work.";
  return message;
}

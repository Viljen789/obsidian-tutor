/**
 * AnkiExportButton({ subject }) — export one subject as a TSV file Anki imports.
 *
 * Mounted on the dashboard's subject rows, alongside ShareButton. One click
 * gathers the subject's concepts (from the already-cached useConcepts query),
 * fetches each concept's cached flashcard deck client-side (Promise.all over
 * getDoc — misses are tolerated, since not every concept has a generated deck),
 * builds a "Basic" Anki TSV via ankiExport.ts, and downloads it as
 * `<subject>-anki.txt`. The learner then drills it in Anki on their phone.
 *
 * Everything is pure client-side: no callable, no new backend. It speaks the
 * reading-room vocabulary (ui.tsx Button / Card / Pill), stays quiet by default
 * (a ghost button) so it never competes with the row's primary actions, and
 * handles loading / empty / error inline — the row never blanks.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { doc, getDoc } from "firebase/firestore";
import { Check, Download } from "lucide-react";
import type { Concept, FlashcardDeck } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { db } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { useConcepts } from "../lib/firestore-hooks";
import {
  buildAnkiRows,
  downloadText,
  toAnkiTsv,
  type ConceptWithCards,
} from "../lib/ankiExport";
import { Button, Card, Pill } from "./ui";

export function AnkiExportButton({ subject }: { subject: string }) {
  const { user } = useAuth();
  const uid = user?.uid;
  // Concepts are already loaded for the dashboard; we read from the same cache.
  const concepts = useConcepts();

  // Track the card count of the last successful export, for the confirmation.
  const [exportedCount, setExportedCount] = useState<number | null>(null);

  const exportMut = useMutation({
    mutationFn: async (): Promise<number> => {
      if (!uid) throw new Error("You need to be signed in to export.");

      const all = (concepts.data ?? []) as Concept[];
      const subjectConcepts = all.filter((c) => c.subject === subject);
      if (subjectConcepts.length === 0) {
        // Nothing to export — surface as the empty state, not an error.
        return 0;
      }

      // Fetch each concept's cached deck in parallel; a missing or unreadable
      // deck is tolerated (concept simply contributes only its recall card).
      const items: ConceptWithCards[] = await Promise.all(
        subjectConcepts.map(async (concept): Promise<ConceptWithCards> => {
          try {
            const snap = await getDoc(
              doc(db, paths.flashcardDoc(uid, concept.id)),
            );
            const deck = snap.exists()
              ? (snap.data() as FlashcardDeck)
              : null;
            return { concept, cards: deck?.cards ?? [] };
          } catch {
            return { concept, cards: [] };
          }
        }),
      );

      const rows = buildAnkiRows(subject, items);
      const tsv = toAnkiTsv(rows);
      if (!tsv) return 0;

      downloadText(`${subject}-anki.txt`, tsv);
      return rows.length;
    },
    onSuccess: (count) => setExportedCount(count),
  });

  // Success with at least one card — confirm in place, with the import hint.
  if (exportMut.isSuccess && (exportedCount ?? 0) > 0) {
    const count = exportedCount ?? 0;
    return (
      <Card className="bg-accent/[0.03]">
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <div className="flex items-center gap-2">
            <Pill tone="accent">
              <Check size={12} />
              Exported {count} {count === 1 ? "card" : "cards"}
            </Pill>
            <span className="text-xs text-muted">{subject}-anki.txt</span>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            In Anki: File → Import, set the field separator to Tab.
          </p>
          <button
            onClick={() => {
              setExportedCount(null);
              exportMut.reset();
            }}
            className="self-start text-xs text-accent transition-colors hover:text-ink"
          >
            Export again
          </button>
        </div>
      </Card>
    );
  }

  // Success but zero cards — nothing was generated for this subject yet.
  if (exportMut.isSuccess && (exportedCount ?? 0) === 0) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="ghost"
          tone="accent"
          size="sm"
          icon={Download}
          onClick={() => {
            exportMut.reset();
            setExportedCount(null);
          }}
        >
          Export to Anki
        </Button>
        <span className="text-xs text-muted">
          No cards to export in this subject yet.
        </span>
      </div>
    );
  }

  // Default / loading / error — a quiet ghost button reflecting its state. It's
  // disabled until the concepts query is ready so we never export an empty set.
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        tone="accent"
        size="sm"
        icon={Download}
        loading={exportMut.isPending}
        disabled={concepts.isPending || !uid}
        onClick={() => exportMut.mutate()}
      >
        {exportMut.isPending
          ? "Exporting"
          : exportMut.isError
            ? "Try again"
            : "Export to Anki"}
      </Button>
      {exportMut.isError && (
        <span className="text-xs text-muted">
          Couldn't build the file. Please try again.
        </span>
      )}
    </div>
  );
}

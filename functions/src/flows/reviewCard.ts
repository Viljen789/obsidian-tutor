/**
 * reviewCard flow — a self-graded flashcard review.
 *
 * A flashcard drill is a recall rep: the learner reveals the answer and rates
 * how well they recalled it (Anki-style Again/Hard/Good/Easy → quality 1/3/4/5).
 * That self-assessment drives the SAME SM-2 / mastery update as a graded
 * free-text answer — no model call — so cards and questions share one schedule.
 *
 * Server-side only: the mastery math is never client-trusted (CONTRACTS §2).
 */
import type { ReviewCardRequest, ReviewCardResponse } from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { getMastery, getSettings, setMastery } from "../lib/firebase";
import { applyGrade, newMastery } from "../engine/index";

export const reviewCard = authedCallable<ReviewCardRequest, ReviewCardResponse>(
  {},
  async (data, { uid }): Promise<ReviewCardResponse> => {
    if (!data.conceptId || typeof data.conceptId !== "string") {
      throw new HttpsError("invalid-argument", "conceptId is required.");
    }
    const raw = Number(data.quality);
    const quality = Number.isFinite(raw) ? Math.round(Math.max(0, Math.min(5, raw))) : 0;

    const settings = await getSettings(uid);
    const current = (await getMastery(uid, data.conceptId)) ?? newMastery(data.conceptId);

    // A self-rated recall maps quality (0..5) to a normalized score (quality/5)
    // for the masteryScore EWMA, then advances SM-2 deterministically.
    const mastery = applyGrade(
      current,
      quality,
      quality / 5,
      Date.now(),
      settings.masteredThreshold,
    );

    await setMastery(uid, mastery);
    return { mastery };
  },
);

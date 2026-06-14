/**
 * Canonical Firestore path builders. Used by the client SDK, the Cloud
 * Functions data layer, and the security-rules tests so all three agree on
 * exactly where each document lives.
 *
 *   users/{uid}
 *   users/{uid}/concepts/{conceptId}
 *   users/{uid}/mastery/{conceptId}
 *   users/{uid}/sessions/{sessionId}
 *   users/{uid}/explanationCache/{conceptId_depth}
 */

export const paths = {
  user: (uid: string) => `users/${uid}`,

  concepts: (uid: string) => `users/${uid}/concepts`,
  concept: (uid: string, conceptId: string) => `users/${uid}/concepts/${conceptId}`,

  mastery: (uid: string) => `users/${uid}/mastery`,
  masteryDoc: (uid: string, conceptId: string) => `users/${uid}/mastery/${conceptId}`,

  sessions: (uid: string) => `users/${uid}/sessions`,
  session: (uid: string, sessionId: string) => `users/${uid}/sessions/${sessionId}`,

  explanationCache: (uid: string) => `users/${uid}/explanationCache`,
  explanationCacheDoc: (uid: string, conceptId: string, depth: string) =>
    `users/${uid}/explanationCache/${conceptId}_${depth}`,

  // Flashcard decks: one cached deck per concept. Functions write, client reads.
  flashcards: (uid: string) => `users/${uid}/flashcards`,
  flashcardDoc: (uid: string, conceptId: string) =>
    `users/${uid}/flashcards/${conceptId}`,

  // Practice-exam history: one record per sat exam. Client read/write own.
  exams: (uid: string) => `users/${uid}/exams`,
  examDoc: (uid: string, examId: string) => `users/${uid}/exams/${examId}`,

  // Activity stats (streak summary). Client read/write own; single summary doc.
  stats: (uid: string) => `users/${uid}/stats`,
  statsDoc: (uid: string) => `users/${uid}/stats/summary`,

  // Study preferences (exam dates, etc.). Client read/write own; single doc.
  prefs: (uid: string) => `users/${uid}/prefs`,
  prefsDoc: (uid: string) => `users/${uid}/prefs/summary`,

  // Read-only shared decks: top-level, public-readable, Functions-written.
  shares: () => `shares`,
  shareDoc: (shareId: string) => `shares/${shareId}`,

  // Cheat sheets: one cached one-pager per subject. Functions-written, client-read.
  cheatSheets: (uid: string) => `users/${uid}/cheatsheets`,
  cheatSheetDoc: (uid: string, key: string) => `users/${uid}/cheatsheets/${key}`,

  // LLM-generated Mermaid diagrams, one per concept. Functions-written, client-read.
  diagrams: (uid: string) => `users/${uid}/diagrams`,
  diagramDoc: (uid: string, conceptId: string) => `users/${uid}/diagrams/${conceptId}`,
} as const;

/** Key for an explanationCache document: `${conceptId}_${depth}`. */
export const explanationCacheKey = (conceptId: string, depth: string) =>
  `${conceptId}_${depth}`;

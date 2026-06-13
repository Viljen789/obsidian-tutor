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
} as const;

/** Key for an explanationCache document: `${conceptId}_${depth}`. */
export const explanationCacheKey = (conceptId: string, depth: string) =>
  `${conceptId}_${depth}`;

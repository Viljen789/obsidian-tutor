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

  // --- Collaboration (Wave 5) ---------------------------------------------
  // Public profiles: top-level, signed-in-readable, Functions-written.
  profiles: () => `profiles`,
  profileDoc: (uid: string) => `profiles/${uid}`,

  // Friend requests: top-level, readable by sender/recipient, Functions-written.
  friendRequests: () => `friendRequests`,
  friendRequestDoc: (requestId: string) => `friendRequests/${requestId}`,

  // Friends: per-user list, owner-read, Functions-written (bidirectional).
  friends: (uid: string) => `users/${uid}/friends`,
  friendDoc: (uid: string, friendUid: string) => `users/${uid}/friends/${friendUid}`,

  // Presence: top-level, owner-write, readable by the owner + their friends.
  presence: () => `presence`,
  presenceDoc: (uid: string) => `presence/${uid}`,

  // Group rooms (Wave 5b): top-level; members read/update; create+join via Functions.
  rooms: () => `rooms`,
  roomDoc: (roomId: string) => `rooms/${roomId}`,
  roomPresence: (roomId: string) => `rooms/${roomId}/presence`,
  roomPresenceDoc: (roomId: string, uid: string) => `rooms/${roomId}/presence/${uid}`,
  roomMessages: (roomId: string) => `rooms/${roomId}/messages`,
  roomMessageDoc: (roomId: string, msgId: string) => `rooms/${roomId}/messages/${msgId}`,

  // Inbox: per-user incoming items (shared decks). Owner read/dismiss; Functions write.
  inbox: (uid: string) => `users/${uid}/inbox`,
  inboxDoc: (uid: string, itemId: string) => `users/${uid}/inbox/${itemId}`,
} as const;

/** Key for an explanationCache document: `${conceptId}_${depth}`. */
export const explanationCacheKey = (conceptId: string, depth: string) =>
  `${conceptId}_${depth}`;

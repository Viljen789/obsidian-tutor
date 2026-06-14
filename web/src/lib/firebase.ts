/**
 * Firebase client init.
 *
 * Three modes:
 *   - dev (default): talks to the local Emulator Suite (demo project, no creds).
 *   - production: real Firebase config from VITE_FIREBASE_* env vars.
 *   - preview (e.g. GitHub Pages with no config): initializes against the demo
 *     project but stays inert — `backendReady` is false, so the app renders the
 *     UI and disables sign-in rather than crashing on a missing backend.
 *
 * Services are always real objects (so module-load code like the callable client
 * never sees `undefined`); `backendReady` gates anything that actually hits the
 * network (auth subscription, sign-in).
 */
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from "firebase/auth";
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";
import { connectStorageEmulator, getStorage } from "firebase/storage";

const useEmulators = import.meta.env.VITE_USE_EMULATORS !== "false";
const hasConfig = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_PROJECT_ID,
);

/** A backend is reachable when emulators are on (dev) or real config is present. */
export const backendReady = useEmulators || hasConfig;

const demoConfig = {
  apiKey: "demo-key",
  authDomain: "demo-tutor.firebaseapp.com",
  projectId: "demo-tutor",
  storageBucket: "demo-tutor.appspot.com",
  appId: "demo-app",
};

const firebaseConfig = hasConfig
  ? {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    }
  : demoConfig;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Persistent IndexedDB cache makes concepts/mastery/flashcards/exams readable
// offline. `persistentMultipleTabManager` keeps the cache coherent across tabs.
// (Modern replacement for the deprecated `enableIndexedDbPersistence`.)
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const functions = getFunctions(app, "us-central1");
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
}

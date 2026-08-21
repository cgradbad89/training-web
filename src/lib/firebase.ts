import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "placeholder",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

const app: FirebaseApp = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

type FirebaseGlobalState = typeof globalThis & {
  __TRAINING_WEB_FIRESTORE__?: Firestore;
};

const firebaseGlobal = globalThis as FirebaseGlobalState;

function getTrainingFirestore(): Firestore {
  if (firebaseGlobal.__TRAINING_WEB_FIRESTORE__) {
    return firebaseGlobal.__TRAINING_WEB_FIRESTORE__;
  }

  let firestore: Firestore;
  if (typeof window === "undefined") {
    // PersistentLocalCache is browser-only. The server bundle does not issue
    // client Firestore reads, but keeping a memory instance makes shared
    // modules safe during SSR/build evaluation.
    firestore = getFirestore(app);
  } else {
    try {
      firestore = initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch (error) {
      // A hot-reloaded development tab may already own an instance created by
      // the previous module. Reuse it; a full reload receives persistent cache.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "failed-precondition"
      ) {
        firestore = getFirestore(app);
      } else {
        throw error;
      }
    }
  }

  firebaseGlobal.__TRAINING_WEB_FIRESTORE__ = firestore;
  return firestore;
}

export const db: Firestore = getTrainingFirestore();
export const auth: Auth = getAuth(app);

if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_USE_PROD_FIRESTORE !== 'true') {
  const globalWithEmulators = globalThis as typeof globalThis & { __EMULATORS_STARTED__?: boolean };
  if (!globalWithEmulators.__EMULATORS_STARTED__) {
    globalWithEmulators.__EMULATORS_STARTED__ = true;
    connectFirestoreEmulator(db, 'localhost', 8080);
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  }
}

export default app;

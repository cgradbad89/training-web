import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getAuth, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "placeholder",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

// users/{uid}/healthMetrics/{YYYY-MM-DD} — HealthMetric daily snapshots
// Rule: match /users/{uid}/healthMetrics/{docId} {
//   allow read, write: if isOwner(uid);
// }

export const db: Firestore = getFirestore(app);
export const auth: Auth = getAuth(app);
export default app;

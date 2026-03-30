import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type UserSettings } from "@/types";

const PREFS_DOC = "prefs";

export async function fetchUserSettings(uid: string): Promise<UserSettings | null> {
  const ref = doc(db, COLLECTIONS.userSettings(uid), PREFS_DOC);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as UserSettings;
}

export async function saveUserSettings(
  uid: string,
  settings: Partial<UserSettings>
): Promise<void> {
  const ref = doc(db, COLLECTIONS.userSettings(uid), PREFS_DOC);
  await setDoc(ref, { ...settings, uid, updatedAt: new Date().toISOString() }, { merge: true });
}

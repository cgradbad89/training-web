import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

const provider = new GoogleAuthProvider();

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

export function onAuthChange(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

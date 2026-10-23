import { initializeApp, deleteApp, getApps, type FirebaseOptions } from "firebase/app";
import { initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, collection, query, orderBy, documentId, limit, getDocs, doc, getDoc, where, or } from "firebase/firestore/lite";
import { isAuthorizedTrainingUser } from "../../src/lib/trainingAuthorization";
import { loadAcceptanceSources, type AcceptanceSources, type ParentRead, type AcceptanceCollection } from "./loader";

export interface AcceptanceIdentity { uid: string; email: string; appName: string }
export interface AcceptanceSession {
  signIn(): Promise<AcceptanceIdentity>;
  load(): Promise<AcceptanceSources>;
  dispose(): Promise<void>;
}

/**
 * Firestore Lite has NO offline cache, IndexedDB persistence, local mutation
 * queue, or snapshot listeners. getDocs/getDoc here are server RPCs. Only these
 * read functions are imported; all SDK handles remain closure-private.
 */
export function createAcceptanceSession(config: FirebaseOptions, onInvalidated?: () => void): AcceptanceSession {
  if (config.projectId !== "malignant-metro" || !config.apiKey || !config.authDomain || !config.appId) {
    throw new Error("Acceptance requires the explicit Training Web public Firebase configuration");
  }
  if (getApps().length > 0) throw new Error("Fail closed: a Firebase application already exists on this acceptance origin");
  const app = initializeApp(config, `training-web-read-only-acceptance-${crypto.randomUUID()}`);
  let disposed = false;
  let epoch = 0;
  let identity: AcceptanceIdentity | null = null;
  let signingIn = false;
  let unsubscribe = () => {};
  const auth = (() => {
    try { return initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver }); }
    catch (error) { void deleteApp(app); throw error; }
  })();
  const firestore = (() => {
    try { return getFirestore(app); }
    catch (error) { void signOut(auth).finally(() => deleteApp(app)); throw error; }
  })();
  function assertOwner(expectedEpoch = epoch): AcceptanceIdentity {
    const user = auth.currentUser;
    if (disposed || expectedEpoch !== epoch || !identity || user?.uid !== identity.uid
      || !isAuthorizedTrainingUser(user.email, user.emailVerified)) {
      throw new Error("Owner session is unavailable or changed; source read refused");
    }
    return identity;
  }
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    epoch++;
    identity = null;
    unsubscribe();
    try { await signOut(auth); }
    finally { await deleteApp(app); }
  }
  unsubscribe = onAuthStateChanged(auth, user => {
    if (identity && (user?.uid !== identity.uid || !isAuthorizedTrainingUser(user.email, user.emailVerified))) {
      epoch++;
      identity = null;
      onInvalidated?.();
      void dispose();
    }
  });
  async function readCollection(source: AcceptanceCollection, cap: number, expectedEpoch: number): Promise<ParentRead> {
    const owner = assertOwner(expectedEpoch);
    const path = source === "activePlans" ? "plans" : source;
    const ref = collection(firestore, "users", owner.uid, path);
    const readStartedAt = new Date().toISOString();
    const boundedQuery = source === "activePlans"
      ? query(ref, or(where("status", "==", "active"), where("isActive", "==", true)), orderBy(documentId()), limit(cap + 1))
      : query(ref, source === "healthWorkouts" ? orderBy("startDate", "desc") : orderBy(documentId()), limit(cap + 1));
    const result = await getDocs(boundedQuery);
    assertOwner(expectedEpoch);
    return { records: result.docs.slice(0, cap).map(item => ({ id: item.id, data: item.data() })),
      cap, capped: result.size > cap, fromServer: true, readStartedAt, readCompletedAt: new Date().toISOString() };
  }
  return {
    async signIn() {
      if (disposed || signingIn) throw new Error("Acceptance sign-in is unavailable");
      if (identity) return assertOwner();
      signingIn = true;
      try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const result = await signInWithPopup(auth, provider);
        if (disposed || result.user.uid !== auth.currentUser?.uid
          || !isAuthorizedTrainingUser(result.user.email, result.user.emailVerified)) {
          throw new Error("Only the verified Training Web owner may load acceptance records");
        }
        identity = { uid: result.user.uid, email: result.user.email!, appName: app.name };
        return assertOwner();
      } catch (error) {
        await dispose();
        throw error;
      } finally { signingIn = false; }
    },
    async load() {
      const currentEpoch = epoch;
      const owner = assertOwner(currentEpoch);
      const sources = await loadAcceptanceSources({
        collection: (source, cap) => readCollection(source, cap, currentEpoch),
        async plan(id) {
          assertOwner(currentEpoch);
          if (!id || id.includes("/")) throw new Error("Invalid linked parent plan ID");
          const readStartedAt = new Date().toISOString();
          const result = await getDoc(doc(firestore, "users", owner.uid, "plans", id));
          assertOwner(currentEpoch);
          return { records: result.exists() ? [{ id: result.id, data: result.data() }] : [], cap: 1,
            capped: false, fromServer: true, readStartedAt, readCompletedAt: new Date().toISOString() };
        },
        async workout(id) {
          assertOwner(currentEpoch);
          if (!id || id.includes("/")) throw new Error("Invalid linked parent workout ID");
          const readStartedAt = new Date().toISOString();
          const result = await getDoc(doc(firestore, "users", owner.uid, "healthWorkouts", id));
          assertOwner(currentEpoch);
          return { records: result.exists() ? [{ id: result.id, data: result.data() }] : [], cap: 1,
            capped: false, fromServer: true, readStartedAt, readCompletedAt: new Date().toISOString() };
        },
      }, owner.uid);
      assertOwner(currentEpoch);
      return sources;
    },
    dispose,
  };
}

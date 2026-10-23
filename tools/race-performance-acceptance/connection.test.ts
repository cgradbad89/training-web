import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  app: { name: "isolated" }, auth: { currentUser: null as null | { uid: string; email: string; emailVerified: boolean } },
  initializeApp: vi.fn(), deleteApp: vi.fn(), getApps: vi.fn(), initializeAuth: vi.fn(), getFirestore: vi.fn(),
  signInWithPopup: vi.fn(), signOut: vi.fn(), onAuthStateChanged: vi.fn(), listener: null as null | ((user: unknown) => void),
  unsubscribe: vi.fn(), getDocs: vi.fn(), getDoc: vi.fn(), collection: vi.fn(), doc: vi.fn(), query: vi.fn(),
  orderBy: vi.fn(), limit: vi.fn(), documentId: vi.fn(), where: vi.fn(), or: vi.fn(), setCustomParameters: vi.fn(),
  memory: { name: "memory-only" }, resolver: { name: "popup" },
}));
vi.mock("firebase/app", () => ({ initializeApp: h.initializeApp, deleteApp: h.deleteApp, getApps: h.getApps }));
vi.mock("firebase/auth", () => ({ initializeAuth: h.initializeAuth, inMemoryPersistence: h.memory, browserPopupRedirectResolver: h.resolver,
  GoogleAuthProvider: class { setCustomParameters = h.setCustomParameters; }, signInWithPopup: h.signInWithPopup,
  signOut: h.signOut, onAuthStateChanged: h.onAuthStateChanged }));
vi.mock("firebase/firestore/lite", () => ({ getFirestore: h.getFirestore, collection: h.collection, doc: h.doc, query: h.query,
  getDocs: h.getDocs, getDoc: h.getDoc, orderBy: h.orderBy, limit: h.limit, documentId: h.documentId, where: h.where, or: h.or }));
import { createAcceptanceSession } from "./connection";

const config = { projectId: "malignant-metro", apiKey: "public-key", authDomain: "malignant-metro.firebaseapp.com", appId: "public-app" };
const owner = { uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true };
beforeEach(() => {
  vi.clearAllMocks();
  h.auth.currentUser = null;
  h.listener = null;
  h.getApps.mockReturnValue([]);
  h.initializeApp.mockImplementation((_config, name) => ({ ...h.app, name }));
  h.initializeAuth.mockReturnValue(h.auth);
  h.getFirestore.mockReturnValue({ isolated: true });
  h.deleteApp.mockResolvedValue(undefined);
  h.signOut.mockImplementation(async () => { h.auth.currentUser = null; });
  h.signInWithPopup.mockImplementation(async () => { h.auth.currentUser = owner; return { user: owner }; });
  h.onAuthStateChanged.mockImplementation((_auth, listener) => { h.listener = listener; return h.unsubscribe; });
  h.getDocs.mockResolvedValue({ size: 0, docs: [] });
  h.getDoc.mockResolvedValue({ exists: () => false });
  h.collection.mockImplementation((_db, ...path) => ({ path: path.join("/") }));
  h.doc.mockImplementation((_db, ...path) => ({ path: path.join("/") }));
  h.query.mockImplementation((ref, ...constraints) => ({ ref, constraints }));
  h.orderBy.mockImplementation((...args) => ({ orderBy: args }));
  h.documentId.mockReturnValue("__name__");
  h.limit.mockImplementation(value => ({ limit: value }));
  h.where.mockImplementation((...args) => ({ where: args }));
  h.or.mockImplementation((...args) => ({ or: args }));
});

describe("isolated read-only owner connection", () => {
  it("creates a unique named app with exclusively memory auth and server-only Lite", async () => {
    const first = createAcceptanceSession(config);
    expect(h.initializeApp).toHaveBeenCalledWith(config, expect.stringMatching(/^training-web-read-only-acceptance-/));
    expect(h.initializeAuth).toHaveBeenCalledWith(expect.anything(), { persistence: h.memory, popupRedirectResolver: h.resolver });
    expect(h.getFirestore).toHaveBeenCalledWith(h.initializeApp.mock.results[0].value);
    expect(Object.keys(first).sort()).toEqual(["dispose", "load", "signIn"]);
    expect(h.signInWithPopup).not.toHaveBeenCalled();
    expect(h.getDocs).not.toHaveBeenCalled();
    await first.dispose();
    const second = createAcceptanceSession(config);
    expect(h.initializeApp.mock.calls[0][1]).not.toBe(h.initializeApp.mock.calls[1][1]);
    await second.dispose();
  });
  it("fails closed on another project, incomplete config, or any preexisting Firebase app", () => {
    expect(() => createAcceptanceSession({ ...config, projectId: "wrong-project" })).toThrow("configuration");
    expect(() => createAcceptanceSession({ ...config, apiKey: "" })).toThrow("configuration");
    h.getApps.mockReturnValue([{ name: "[DEFAULT]" }]);
    expect(() => createAcceptanceSession(config)).toThrow("already exists");
    expect(h.initializeApp).not.toHaveBeenCalled();
  });
  it("does not issue reads before explicit verified-owner popup authentication", async () => {
    const session = createAcceptanceSession(config);
    await expect(session.load()).rejects.toThrow("read refused");
    expect(h.getDocs).not.toHaveBeenCalled();
    const identity = await session.signIn();
    expect(identity).toMatchObject({ uid: "owner", email: owner.email });
    expect(h.setCustomParameters).toHaveBeenCalledWith({ prompt: "select_account" });
    const result = await session.load();
    expect(result.sourcesReady).toBe(true);
    expect(h.getDocs).toHaveBeenCalledTimes(4);
    expect(h.collection.mock.calls.map(call => call.slice(1))).toEqual([
      ["users", "owner", "healthWorkouts"], ["users", "owner", "halfMarathonRaces"],
      ["users", "owner", "workoutOverrides"], ["users", "owner", "plans"],
    ]);
    expect(h.orderBy).toHaveBeenCalledWith("startDate", "desc");
    expect(h.limit).toHaveBeenCalledWith(1001);
    await session.dispose();
  });
  it.each([
    { ...owner, email: "intruder@example.com" }, { ...owner, emailVerified: false },
  ])("cleans up unauthorized/unverified popup identity %j without any Firestore reads", async user => {
    h.signInWithPopup.mockImplementation(async () => { h.auth.currentUser = user; return { user }; });
    const session = createAcceptanceSession(config);
    await expect(session.signIn()).rejects.toThrow("verified Training Web owner");
    expect(h.getDocs).not.toHaveBeenCalled();
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.deleteApp).toHaveBeenCalledTimes(1);
    await expect(session.load()).rejects.toThrow("read refused");
  });
  it("deletes memory-only auth and the named app on popup failure without a persistence fallback", async () => {
    h.signInWithPopup.mockRejectedValue(new Error("auth/web-storage-unsupported"));
    const session = createAcceptanceSession(config);
    await expect(session.signIn()).rejects.toThrow("auth/web-storage-unsupported");
    expect(h.initializeAuth).toHaveBeenCalledTimes(1);
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.deleteApp).toHaveBeenCalledTimes(1);
    await expect(session.signIn()).rejects.toThrow("unavailable");
  });
  it("rejects in-flight data when the owner UID changes and notifies the UI to clear stale records", async () => {
    const invalidated = vi.fn();
    const session = createAcceptanceSession(config, invalidated);
    await session.signIn();
    let resolveRead!: (value: unknown) => void;
    const deferred = new Promise(resolve => { resolveRead = resolve; });
    h.getDocs.mockReturnValue(deferred);
    const loading = session.load();
    h.auth.currentUser = { ...owner, uid: "different" };
    h.listener?.(h.auth.currentUser);
    resolveRead({ size: 0, docs: [] });
    await expect(loading).rejects.toThrow("read refused");
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(h.deleteApp).toHaveBeenCalledTimes(1);
  });
  it("detects a changed current user even before the auth listener fires", async () => {
    const session = createAcceptanceSession(config);
    await session.signIn();
    h.auth.currentUser = { ...owner, uid: "different" };
    await expect(session.load()).rejects.toThrow("read refused");
    expect(h.getDocs).not.toHaveBeenCalled();
    await session.dispose();
  });
  it("reads linked race parent documents through Lite only, never route/HR subcollections", async () => {
    const session = createAcceptanceSession(config);
    await session.signIn();
    h.getDocs.mockImplementation(async (q: { ref: { path: string } }) => q.ref.path.endsWith("halfMarathonRaces")
      ? { size: 1, docs: [{ id: "race", data: () => ({ name: "Half", raceDate: "2026-04-26", raceDistance: "halfMarathon", actualRunId: "race-workout", linkedPlanId: "race-plan" }) }] }
      : { size: 0, docs: [] });
    const result = await session.load();
    expect(result.sourcesReady).toBe(true);
    expect(h.doc.mock.calls.map(call => call.slice(1))).toEqual([
      ["users", "owner", "healthWorkouts", "race-workout"], ["users", "owner", "plans", "race-plan"],
    ]);
    expect(h.getDoc).toHaveBeenCalledTimes(2);
    await session.dispose();
  });
  it("makes disposal idempotent and prevents every later read or sign-in", async () => {
    const session = createAcceptanceSession(config);
    await session.signIn();
    await session.dispose();
    await session.dispose();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.deleteApp).toHaveBeenCalledTimes(1);
    await expect(session.load()).rejects.toThrow("read refused");
    await expect(session.signIn()).rejects.toThrow("unavailable");
    expect(h.getDocs).not.toHaveBeenCalled();
  });
});

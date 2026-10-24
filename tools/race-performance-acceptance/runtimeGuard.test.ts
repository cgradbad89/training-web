// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReadRequest, installRuntimeGuard } from "./runtimeGuard";

const owner = "acceptance-owner";
const resource = "projects/malignant-metro/databases/(default)/documents";
const queryURL = `https://firestore.googleapis.com/v1/${resource}/users/${owner}:runQuery`;
const batchURL = `https://firestore.googleapis.com/v1/${resource}:batchGet`;
function parentQuery(collectionId = "healthWorkouts", limit = 1001) {
  return JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit } });
}
function linkedParent(path: string) {
  return JSON.stringify({ documents: [`${resource}/users/${owner}/${path}`] });
}

afterEach(() => vi.unstubAllGlobals());

describe("acceptance Firestore read boundary", () => {
  it.each([
    ["healthWorkouts", 1001], ["halfMarathonRaces", 101],
    ["workoutOverrides", 1001], ["plans", 21],
  ] as const)("allows only a bounded %s parent query", (collection, cap) => {
    expect(assertReadRequest(queryURL, "POST", parentQuery(collection, cap), owner))
      .toBe(`POST parent query: ${collection}; limit ${cap}`);
    expect(() => assertReadRequest(queryURL, "POST", parentQuery(collection, cap + 1), owner)).toThrow();
  });

  it("allows active plan filtering and newest-workout ordering within the parent bound", () => {
    const activePlans = JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "plans" }], limit: 21,
      where: { compositeFilter: { op: "OR", filters: [
        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } },
        { fieldFilter: { field: { fieldPath: "isActive" }, op: "EQUAL", value: { booleanValue: true } } },
      ] } }, orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
    } });
    const recentWorkouts = JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "healthWorkouts" }], limit: 1001,
      orderBy: [{ field: { fieldPath: "startDate" }, direction: "DESCENDING" }],
    } });
    expect(assertReadRequest(queryURL, "POST", activePlans, owner)).toContain("plans");
    expect(assertReadRequest(queryURL, "POST", recentWorkouts, owner)).toContain("healthWorkouts");
  });

  it.each(["healthWorkouts/race-workout", "plans/race-plan"])("allows a single explicit linked parent: %s", path => {
    expect(assertReadRequest(batchURL, "POST", linkedParent(path), owner)).toContain(path.split("/")[0]);
  });

  it("rejects mutation RPCs, direct document requests and listen/write transports", () => {
    for (const path of [
      `${resource}:commit`, `${resource}:batchWrite`,
      `${resource}/users/${owner}/healthWorkouts/race-workout`,
      "google.firestore.v1.Firestore/Write/channel", "google.firestore.v1.Firestore/Listen/channel",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "GET"]) {
        expect(() => assertReadRequest(`https://firestore.googleapis.com/v1/${path}`, method, "{}", owner)).toThrow();
      }
    }
    for (const method of ["PUT", "PATCH", "DELETE", "GET"]) {
      expect(() => assertReadRequest(queryURL, method, parentQuery(), owner)).toThrow();
    }
  });

  it("rejects absent authorization, another owner/project and non-HTTPS transports", () => {
    for (const uid of [null, "", "different-owner", "invalid/owner"]) {
      expect(() => assertReadRequest(queryURL, "POST", parentQuery(), uid)).toThrow();
    }
    for (const url of [
      queryURL.replace("malignant-metro", "another-project"),
      queryURL.replace("https:", "http:"),
      queryURL.replace(`users/${owner}`, "users/another-owner"),
    ]) {
      expect(() => assertReadRequest(url, "POST", parentQuery(), owner)).toThrow();
    }
    expect(() => assertReadRequest(queryURL.replace("firestore.googleapis.com", "firestore.googleapis.com:8443"), "POST", parentQuery(), owner)).toThrow();
  });

  it("rejects GPS/HR children, collection groups and unrelated collections", () => {
    for (const collection of ["route", "routeChunks", "hrSamples", "heartRate", "mileSplits", "settings", "healthMetrics"]) {
      expect(() => assertReadRequest(queryURL, "POST", parentQuery(collection, 1), owner)).toThrow();
      expect(() => assertReadRequest(batchURL, "POST", linkedParent(`healthWorkouts/run/${collection}/chunk`), owner)).toThrow();
    }
    for (const body of [
      JSON.stringify({ structuredQuery: { from: [{ collectionId: "healthWorkouts", allDescendants: true }], limit: 1 } }),
      JSON.stringify({ structuredQuery: { from: [{ collectionId: "healthWorkouts" }, { collectionId: "plans" }], limit: 1 } }),
    ]) expect(() => assertReadRequest(queryURL, "POST", body, owner)).toThrow();
    const childQuery = queryURL.replace(":runQuery", "/healthWorkouts/run:runQuery");
    expect(() => assertReadRequest(childQuery, "POST", parentQuery("plans", 1), owner)).toThrow();
  });

  it("rejects unbounded, malformed or additional query/envelope fields", () => {
    for (const limit of [undefined, 0, -1, 0.5, "10", null]) {
      const body = JSON.stringify({ structuredQuery: { from: [{ collectionId: "healthWorkouts" }], limit } });
      expect(() => assertReadRequest(queryURL, "POST", body, owner)).toThrow();
    }
    for (const body of [
      "not JSON", "null", "{}", undefined, new Uint8Array(),
      JSON.stringify({ structuredQuery: { from: [{ collectionId: "plans" }], limit: 1, offset: 1000 } }),
      JSON.stringify({ structuredQuery: { from: [{ collectionId: "plans" }], limit: 1 }, newTransaction: {} }),
    ]) expect(() => assertReadRequest(queryURL, "POST", body, owner)).toThrow();
  });

  it("rejects linked reads outside the two explicitly allowed owner parent collections", () => {
    for (const path of ["halfMarathonRaces/race", "workoutOverrides/run", "healthWorkouts/", "healthWorkouts/run/hrSamples/chunk"]) {
      expect(() => assertReadRequest(batchURL, "POST", linkedParent(path), owner)).toThrow();
    }
    for (const body of [
      JSON.stringify({ documents: [] }),
      JSON.stringify({ documents: [`${resource}/users/${owner}/plans/a`, `${resource}/users/${owner}/plans/b`] }),
      JSON.stringify({ documents: [`${resource}/users/other/plans/a`] }),
      JSON.stringify({ documents: [`${resource}/users/${owner}/plans/a`], transaction: "not-allowed" }),
    ]) expect(() => assertReadRequest(batchURL, "POST", body, owner)).toThrow();
  });

  it("does not classify ordinary authentication and local UI requests as Firestore reads", () => {
    for (const url of ["https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp", "https://securetoken.googleapis.com/v1/token", "http://localhost:4186/main.tsx"]) {
      expect(assertReadRequest(url, "POST", "{}", null)).toBeNull();
    }
  });

  it("rejects alternate Firestore hostnames and prefixed proxy endpoints", () => {
    for (const url of [
      queryURL.replace("firestore.googleapis.com", "regional-firestore.googleapis.com"),
      queryURL.replace("firestore.googleapis.com", "firestore.googleapis.com.example.com"),
      queryURL.replace("firestore.googleapis.com", "firestore.sandbox.example.com"),
      `https://proxy.example.com/firestore/v1/${resource}/users/${owner}:runQuery`,
      `http://localhost:4186/firestore/v1/${resource}:commit`,
    ]) {
      expect(() => assertReadRequest(url, "POST", parentQuery(), owner)).toThrow("Alternate Firestore endpoint denied");
    }
  });
});

function fakeBrowser(origin = "http://localhost:4186") {
  const indexedDBOpen = vi.fn();
  const indexedDBDelete = vi.fn();
  const storageSet = vi.fn();
  const storageRemove = vi.fn();
  const storageClear = vi.fn();
  const xhrOpen = vi.fn();
  const xhrSend = vi.fn();
  const nativeFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  class FakeStorage {
    setItem(key: string, value: string) { storageSet(key, value); }
    removeItem(key: string) { storageRemove(key); }
    clear() { storageClear(); }
  }
  class FakeXHR {
    open(method: string, url: string | URL) { xhrOpen(method, url); }
    send(body?: unknown) { xhrSend(body); }
  }
  const idb = { open: indexedDBOpen, deleteDatabase: indexedDBDelete };
  vi.stubGlobal("location", { origin, href: `${origin}/` });
  vi.stubGlobal("indexedDB", idb);
  vi.stubGlobal("Storage", FakeStorage);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("fetch", nativeFetch);
  return { indexedDBOpen, indexedDBDelete, storageSet, storageRemove, storageClear, xhrOpen, xhrSend, nativeFetch, idb, FakeStorage, FakeXHR };
}

describe("acceptance runtime instrumentation", () => {
  it("refuses installation outside the dedicated local origin before touching browser APIs", () => {
    const browser = fakeBrowser("https://training-web-rho.vercel.app");
    expect(() => installRuntimeGuard()).toThrow("dedicated");
    expect(browser.idb.open).toBe(browser.indexedDBOpen);
    expect(globalThis.fetch).toBe(browser.nativeFetch);
  });

  it("rejects IndexedDB open/delete and Storage writes before native persistence runs", () => {
    const browser = fakeBrowser();
    const guard = installRuntimeGuard();
    expect(() => browser.idb.open()).toThrow("IndexedDB is prohibited");
    expect(() => browser.idb.deleteDatabase()).toThrow("IndexedDB deletion is prohibited");
    expect(() => new browser.FakeStorage().setItem("firebase:authUser", "test")).toThrow("Persistent browser storage is prohibited");
    expect(() => new browser.FakeStorage().removeItem("firebase:authUser")).toThrow("Persistent browser storage is prohibited");
    expect(() => new browser.FakeStorage().clear()).toThrow("Persistent browser storage is prohibited");
    expect(browser.indexedDBOpen).not.toHaveBeenCalled();
    expect(browser.indexedDBDelete).not.toHaveBeenCalled();
    expect(browser.storageSet).not.toHaveBeenCalled();
    expect(browser.storageRemove).not.toHaveBeenCalled();
    expect(browser.storageClear).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(browser.idb, "open")).toMatchObject({ configurable: false, writable: false });
    expect(Object.getOwnPropertyDescriptor(browser.FakeStorage.prototype, "clear")).toMatchObject({ configurable: false, writable: false });
    expect(guard.snapshot()).toMatchObject({ indexedDBOpenDenied: 1, indexedDBDeleteDenied: 1, storageWritesDenied: 3 });
  });

  it("blocks fetch before authorization, permits bounded owner reads and revokes immediately", async () => {
    const browser = fakeBrowser();
    const guard = installRuntimeGuard();
    await expect(fetch(queryURL, { method: "POST", body: parentQuery() })).rejects.toThrow();
    expect(browser.nativeFetch).not.toHaveBeenCalled();
    guard.authorizeOwner(owner);
    await fetch(queryURL, { method: "post", body: parentQuery() });
    await fetch(new Request(batchURL, { method: "POST", body: linkedParent("plans/target") }));
    expect(browser.nativeFetch).toHaveBeenCalledTimes(2);
    guard.revokeOwner();
    await expect(fetch(queryURL, { method: "POST", body: parentQuery() })).rejects.toThrow();
    expect(browser.nativeFetch).toHaveBeenCalledTimes(2);
    expect(guard.snapshot()).toMatchObject({ readRPCs: 2, forbiddenRequestsDenied: 2, ownerAuthorized: false });
  });

  it("denies write, cross-owner and child fetch requests without forwarding bodies to the network", async () => {
    const browser = fakeBrowser();
    const guard = installRuntimeGuard();
    guard.authorizeOwner(owner);
    const forbidden = [
      [batchURL.replace(":batchGet", ":commit"), "{}"],
      [queryURL.replace(owner, "someone-else"), parentQuery()],
      [batchURL, linkedParent("healthWorkouts/run/routeChunks/chunk")],
      [queryURL, parentQuery("hrSamples", 1)],
    ];
    for (const [url, body] of forbidden) await expect(fetch(url, { method: "POST", body })).rejects.toThrow();
    expect(browser.nativeFetch).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({ readRPCs: 0, forbiddenRequestsDenied: 4, requests: [] });
  });

  it("inspects XHR sends, allowing reads while rejecting mutations and child requests before native send", () => {
    const browser = fakeBrowser();
    const guard = installRuntimeGuard();
    guard.authorizeOwner(owner);
    const read = new browser.FakeXHR();
    read.open("post", queryURL);
    read.send(parentQuery("halfMarathonRaces", 101));
    expect(browser.xhrSend).toHaveBeenCalledOnce();
    for (const [url, body] of [
      [batchURL.replace(":batchGet", ":batchWrite"), "{}"],
      [batchURL, linkedParent("healthWorkouts/run/hrSamples/chunk")],
      [queryURL.replace(owner, "someone-else"), parentQuery()],
    ]) {
      const xhr = new browser.FakeXHR();
      xhr.open("POST", url);
      expect(() => xhr.send(body)).toThrow();
    }
    expect(() => new browser.FakeXHR().send("{}")).toThrow("XHR without inspected open");
    expect(browser.xhrSend).toHaveBeenCalledOnce();
    expect(guard.snapshot()).toMatchObject({ readRPCs: 1, forbiddenRequestsDenied: 4 });
  });

  it("does not forward alternate Firestore endpoints through either fetch or XHR", async () => {
    const browser = fakeBrowser();
    const guard = installRuntimeGuard();
    guard.authorizeOwner(owner);
    const url = queryURL.replace("firestore.googleapis.com", "regional-firestore.googleapis.com");
    await expect(fetch(url, { method: "POST", body: parentQuery() })).rejects.toThrow("Alternate Firestore endpoint denied");
    const xhr = new browser.FakeXHR();
    xhr.open("POST", `https://proxy.example.com/firestore/v1/${resource}:commit`);
    expect(() => xhr.send("{}")).toThrow("Alternate Firestore endpoint denied");
    expect(browser.nativeFetch).not.toHaveBeenCalled();
    expect(browser.xhrSend).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({ readRPCs: 0, forbiddenRequestsDenied: 2 });
  });

  it("does not count auth traffic as data reads and exposes only copy-isolated safe labels", async () => {
    const browser = fakeBrowser();
    const guard = installRuntimeGuard();
    await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp", { method: "POST", body: "sensitive-auth-body" });
    guard.authorizeOwner(owner);
    await fetch(queryURL, { method: "POST", body: parentQuery("workoutOverrides", 1001) });
    expect(browser.nativeFetch).toHaveBeenCalledTimes(2);
    const snapshot = guard.snapshot();
    expect(snapshot.requests).toEqual(["POST parent query: workoutOverrides; limit 1001"]);
    expect(JSON.stringify(snapshot)).not.toContain(owner);
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-auth-body");
    snapshot.requests.push("altered by caller");
    expect(guard.snapshot().requests).toHaveLength(1);
    expect(() => guard.authorizeOwner("second-owner")).toThrow();
  });
});

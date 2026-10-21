import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ getDocs: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, ...path: string[]) => path.join("/"),
  query: (path: string, ...constraints: unknown[]) => ({ path, constraints }),
  orderBy: (field: string, direction: string) => ({ orderBy: field, direction }),
  limit: (count: number) => ({ limit: count }),
  startAfter: (cursor: unknown) => ({ startAfter: cursor }), getDocsFromServer: h.getDocs,
}));
import { fetchRoutePoints, RouteReadLimitExceededError, ROUTE_PAGE_SIZE } from "../routes";
function docs(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({ id: String(offset + index), data: () => ({ index: offset + index, lat: 0, lng: 0, timestamp: { toDate: () => new Date(0) } }) }));
}
beforeEach(() => h.getDocs.mockReset());
describe("bounded full-route acquisition", () => {
  it("pages with an explicit limit and cursor without losing or duplicating points", async () => {
    const first = docs(ROUTE_PAGE_SIZE); h.getDocs.mockResolvedValueOnce({ docs: first }).mockResolvedValueOnce({ docs: docs(2, ROUTE_PAGE_SIZE) });
    const result = await fetchRoutePoints("synthetic-owner", "run");
    expect(result).toHaveLength(252); expect(result[251].index).toBe(251);
    expect(h.getDocs.mock.calls[0][0].constraints).toContainEqual({ limit: 250 });
    expect(h.getDocs.mock.calls[1][0].constraints).toContainEqual({ startAfter: first[249] });
  });
  it("rejects overflow rather than returning a truncated route", async () => {
    h.getDocs.mockResolvedValue({ docs: docs(4) });
    await expect(fetchRoutePoints("synthetic-owner", "run", { maxDocuments: 3 })).rejects.toBeInstanceOf(RouteReadLimitExceededError);
    expect(h.getDocs.mock.calls[0][0].constraints).toContainEqual({ limit: 4 });
  });
  it("accepts an exhausted exact cap and an empty route", async () => {
    h.getDocs.mockResolvedValueOnce({ docs: docs(3) }).mockResolvedValueOnce({ docs: [] });
    expect(await fetchRoutePoints("synthetic-owner", "run", { maxDocuments: 3 })).toHaveLength(3);
    expect(await fetchRoutePoints("synthetic-owner", "empty")).toEqual([]);
  });
  it("uses a one-document server probe to prove exhaustion at a full-page cap", async () => {
    h.getDocs.mockResolvedValueOnce({ docs: docs(250) }).mockResolvedValueOnce({ docs: [] });
    expect(await fetchRoutePoints("synthetic-owner", "run", { maxDocuments: 250 })).toHaveLength(250);
    expect(h.getDocs.mock.calls[1][0].constraints).toContainEqual({ limit: 1 });
  });
  it("rejects a positive overflow probe without returning the accepted first page", async () => {
    h.getDocs.mockResolvedValueOnce({ docs: docs(250) }).mockResolvedValueOnce({ docs: docs(1, 250) });
    await expect(fetchRoutePoints("synthetic-owner", "run", { maxDocuments: 250 })).rejects.toBeInstanceOf(RouteReadLimitExceededError);
    expect(h.getDocs).toHaveBeenCalledTimes(2);
  });
  it("stops before another page when the session retires during the first query", async () => {
    let active = true;
    h.getDocs.mockImplementation(async () => { active = false; return { docs: docs(250) }; });
    await expect(fetchRoutePoints("synthetic-owner", "run", { isCurrent: () => active })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.getDocs).toHaveBeenCalledOnce();
  });
  it("does not query a retired session or accept an invalid limit", async () => {
    await expect(fetchRoutePoints("synthetic-owner", "run", { isCurrent: () => false })).rejects.toMatchObject({ name: "AbortError" });
    await expect(fetchRoutePoints("synthetic-owner", "run", { maxDocuments: 0 })).rejects.toThrow(RangeError);
    expect(h.getDocs).not.toHaveBeenCalled();
  });
  it("rejects a lost server connection between pages rather than treating cached emptiness as exhaustion", async () => {
    h.getDocs.mockResolvedValueOnce({ docs: docs(250) }).mockRejectedValueOnce(new Error("unavailable"));
    await expect(fetchRoutePoints("synthetic-owner", "run")).rejects.toThrow("unavailable");
    expect(h.getDocs).toHaveBeenCalledTimes(2);
  });
});

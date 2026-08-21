import { beforeEach, describe, expect, it, vi } from "vitest";
import * as firestore from "firebase/firestore";
import {
  fetchLatestVo2SampleDate,
  VO2_FRESHNESS_LOOKUP_LIMIT,
} from "../healthMetrics";

vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    collection: vi.fn(),
    getDocs: vi.fn(),
    limit: vi.fn((count) => ({ kind: "limit", count })),
    orderBy: vi.fn((field, direction) => ({ kind: "orderBy", field, direction })),
    query: vi.fn((...parts) => ({ parts })),
    where: vi.fn(),
  };
});

describe("fetchLatestVo2SampleDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries a small newest-first window instead of a 180-day range", async () => {
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);

    await fetchLatestVo2SampleDate("uid-1");

    expect(firestore.collection).toHaveBeenCalledWith(
      expect.anything(),
      "users/uid-1/healthMetrics"
    );
    expect(firestore.orderBy).toHaveBeenCalledWith("date", "desc");
    expect(firestore.limit).toHaveBeenCalledWith(VO2_FRESHNESS_LOOKUP_LIMIT);
    expect(firestore.where).not.toHaveBeenCalled();
    expect(VO2_FRESHNESS_LOOKUP_LIMIT).toBeLessThan(180);
  });

  it("returns the first qualifying VO2 date in newest-first results", async () => {
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        { id: "2026-08-20", data: () => ({ date: "2026-08-20" }) },
        {
          id: "2026-08-19",
          data: () => ({ date: "2026-08-19", vo2_max: 51 }),
        },
        {
          id: "2026-08-18",
          data: () => ({ date: "2026-08-18", vo2_max: 49 }),
        },
      ],
    } as any);

    await expect(fetchLatestVo2SampleDate("uid-1")).resolves.toBe(
      "2026-08-19"
    );
  });

  it("falls back to the document id when the date field is absent", async () => {
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [{ id: "2026-08-14", data: () => ({ vo2_max: 50 }) }],
    } as any);

    await expect(fetchLatestVo2SampleDate("uid-1")).resolves.toBe(
      "2026-08-14"
    );
  });

  it("returns null when the bounded window has no positive VO2 sample", async () => {
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        { id: "2026-08-20", data: () => ({ vo2_max: 0 }) },
        { id: "2026-08-19", data: () => ({}) },
      ],
    } as any);

    await expect(fetchLatestVo2SampleDate("uid-1")).resolves.toBeNull();
  });
});

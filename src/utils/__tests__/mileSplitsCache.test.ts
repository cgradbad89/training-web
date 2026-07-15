import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMileSplits } from "../mileSplitsCache";
import * as firestore from "firebase/firestore";

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  getDocs: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({
  db: {},
}));

describe("mileSplitsCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches from Firestore on cache miss", async () => {
    const mockDocs = [
      { id: "split1", data: () => ({ mile: 1, avgBpm: 150 }) },
    ];
    vi.mocked(firestore.getDocs).mockResolvedValueOnce({ docs: mockDocs } as any);

    const result = await getMileSplits("uid1", "workout1");

    expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "split1", mile: 1, avgBpm: 150 }]);
  });

  it("returns cached data on cache hit without a new fetch call", async () => {
    const mockDocs = [
      { id: "split1", data: () => ({ mile: 1, avgBpm: 150 }) },
    ];
    vi.mocked(firestore.getDocs).mockResolvedValueOnce({ docs: mockDocs } as any);

    await getMileSplits("uid2", "workout2");
    expect(firestore.getDocs).toHaveBeenCalledTimes(1);

    const result2 = await getMileSplits("uid2", "workout2");
    expect(firestore.getDocs).toHaveBeenCalledTimes(1); // No new fetch
    expect(result2).toEqual([{ id: "split1", mile: 1, avgBpm: 150 }]);
  });

  it("does not collide for different workoutIds/uids", async () => {
    const mockDocsA = [{ id: "splitA", data: () => ({ mile: 1 }) }];
    const mockDocsB = [{ id: "splitB", data: () => ({ mile: 2 }) }];
    
    vi.mocked(firestore.getDocs)
      .mockResolvedValueOnce({ docs: mockDocsA } as any)
      .mockResolvedValueOnce({ docs: mockDocsB } as any);

    const resultA = await getMileSplits("uid3", "workoutA");
    const resultB = await getMileSplits("uid3", "workoutB");

    expect(firestore.getDocs).toHaveBeenCalledTimes(2);
    expect(resultA).toEqual([{ id: "splitA", mile: 1 }]);
    expect(resultB).toEqual([{ id: "splitB", mile: 2 }]);
  });

  it("deduplicates concurrent fetches", async () => {
    const mockDocs = [{ id: "splitC", data: () => ({ mile: 1 }) }];
    
    // Create a delayed promise to simulate in-flight request
    let resolveDocs: any;
    const pendingPromise = new Promise((resolve) => {
      resolveDocs = () => resolve({ docs: mockDocs });
    });
    
    vi.mocked(firestore.getDocs).mockReturnValueOnce(pendingPromise as any);

    const promise1 = getMileSplits("uid4", "workoutC");
    const promise2 = getMileSplits("uid4", "workoutC");

    expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    
    resolveDocs();
    const [res1, res2] = await Promise.all([promise1, promise2]);
    
    expect(res1).toEqual(res2);
    expect(res1).toEqual([{ id: "splitC", mile: 1 }]);
  });
});

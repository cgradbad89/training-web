import { beforeEach, describe, expect, it, vi } from "vitest";
import * as firestore from "firebase/firestore";
import {
  AUTO_MATCH_CANDIDATE_PAGE_SIZE,
  fetchAutoMatchCandidatesThroughDate,
} from "@/services/healthWorkouts";
import { type HealthWorkout } from "@/types/healthWorkout";

const h = vi.hoisted(() => ({
  getDocs: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    collection: vi.fn(() => ({ kind: "collection" })),
    getDocs: h.getDocs,
    limit: vi.fn((count: number) => ({ kind: "limit", count })),
    orderBy: vi.fn((field: string, direction: string) => ({
      kind: "orderBy",
      field,
      direction,
    })),
    query: vi.fn((_collection: unknown, ...constraints: unknown[]) => ({
      constraints,
    })),
    startAfter: vi.fn((cursor: unknown) => ({ kind: "startAfter", cursor })),
    where: vi.fn((field: string, operator: string, value: unknown) => ({
      kind: "where",
      field,
      operator,
      value,
    })),
  };
});

const dueDay = new Date(2026, 7, 1);

function workout(id: string, startDate: Date): HealthWorkout {
  return {
    workoutId: id,
    startDate,
    endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
    isRunLike: false,
    activityType: "traditionalStrengthTraining",
  } as HealthWorkout;
}

function workoutPage(prefix: string, count: number, startDate: Date) {
  return Array.from({ length: count }, (_, index) =>
    workout(`${prefix}-${index}`, startDate)
  );
}

function firestoreDocument(
  id: string,
  startDate: Date,
  workoutId: string = id
) {
  return {
    id,
    data: () => ({
      workoutId,
      startDate,
      endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
      syncedAt: startDate,
      isRunLike: false,
      activityType: "traditionalStrengthTraining",
    }),
  };
}

beforeEach(() => {
  h.getDocs.mockReset();
  vi.mocked(firestore.collection).mockClear();
  vi.mocked(firestore.limit).mockClear();
  vi.mocked(firestore.orderBy).mockClear();
  vi.mocked(firestore.query).mockClear();
  vi.mocked(firestore.startAfter).mockClear();
  vi.mocked(firestore.where).mockClear();
});

describe("fetchAutoMatchCandidatesThroughDate", () => {
  it("returns a short live first page without an additional Firestore read", async () => {
    const firstPage = workoutPage("recent", 12, new Date(2026, 7, 2, 12));

    const result = await fetchAutoMatchCandidatesThroughDate("u1", dueDay, {
      initialCandidates: firstPage,
      initialCursor: { id: "last" } as never,
    });

    expect(result).toEqual(firstPage);
    expect(h.getDocs).not.toHaveBeenCalled();
  });

  it.each([
    { total: 250, expectedQueries: 2 },
    { total: 500, expectedQueries: 3 },
    { total: 750, expectedQueries: 4 },
  ])(
    "returns exactly $total candidates and proves exhaustion with $expectedQueries queries",
    async ({ total, expectedQueries }) => {
      const documents = Array.from({ length: total }, (_, index) =>
        firestoreDocument(
          `candidate-${index}`,
          new Date(dueDay.getTime() + (total - index) * 60_000)
        )
      );
      const fullPages = Array.from(
        { length: total / AUTO_MATCH_CANDIDATE_PAGE_SIZE },
        (_, index) =>
          documents.slice(
            index * AUTO_MATCH_CANDIDATE_PAGE_SIZE,
            (index + 1) * AUTO_MATCH_CANDIDATE_PAGE_SIZE
          )
      );
      for (const page of fullPages) {
        h.getDocs.mockResolvedValueOnce({ docs: page });
      }
      h.getDocs.mockResolvedValueOnce({ docs: [] });

      const result = await fetchAutoMatchCandidatesThroughDate("u1", dueDay);

      expect(h.getDocs).toHaveBeenCalledTimes(expectedQueries);
      expect(result).toHaveLength(total);
      expect(new Set(result.map((candidate) => candidate.workoutId)).size).toBe(
        total
      );
      expect(result.map((candidate) => candidate.workoutId)).toEqual(
        documents.map((document) => document.id)
      );
      expect(firestore.startAfter).toHaveBeenCalledTimes(fullPages.length);
      fullPages.forEach((page, index) => {
        expect(firestore.startAfter).toHaveBeenNthCalledWith(
          index + 1,
          page.at(-1)
        );
      });
      expect(firestore.where).toHaveBeenCalledWith(
        "startDate",
        ">=",
        dueDay
      );
      expect(
        documents.every(
          (document) =>
            (document.data().startDate as Date).getTime() >= dueDay.getTime()
        )
      ).toBe(true);
    }
  );

  it("finds a due-day candidate hidden behind 250 newer workouts", async () => {
    const firstPage = workoutPage(
      "recent",
      AUTO_MATCH_CANDIDATE_PAGE_SIZE,
      new Date(2026, 7, 2, 12)
    );
    const cursor = { id: "page-1-last" };
    h.getDocs.mockResolvedValueOnce({
      docs: [firestoreDocument("due-candidate", new Date(2026, 7, 1, 8))],
    });

    const result = await fetchAutoMatchCandidatesThroughDate("u1", dueDay, {
      initialCandidates: firstPage,
      initialCursor: cursor as never,
    });

    expect(result.at(-1)?.workoutId).toBe("due-candidate");
    expect(h.getDocs).toHaveBeenCalledTimes(1);
    expect(firestore.startAfter).toHaveBeenCalledWith(cursor);
    expect(firestore.where).toHaveBeenCalledWith("isRunLike", "==", false);
    expect(firestore.where).toHaveBeenCalledWith(
      "startDate",
      ">=",
      dueDay
    );
    expect(firestore.limit).toHaveBeenCalledWith(
      AUTO_MATCH_CANDIDATE_PAGE_SIZE
    );
  });

  it("continues to page 3 when page 2 only reaches midday on the due date", async () => {
    const firstPage = workoutPage(
      "page-1",
      AUTO_MATCH_CANDIDATE_PAGE_SIZE,
      new Date(2026, 7, 3, 12)
    );
    const page2 = Array.from(
      { length: AUTO_MATCH_CANDIDATE_PAGE_SIZE },
      (_, index) =>
        firestoreDocument(`page-2-${index}`, new Date(2026, 7, 1, 14))
    );
    const morningCandidate = firestoreDocument(
      "morning-candidate",
      new Date(2026, 7, 1, 8)
    );
    h.getDocs
      .mockResolvedValueOnce({ docs: page2 })
      .mockResolvedValueOnce({ docs: [morningCandidate] });

    const result = await fetchAutoMatchCandidatesThroughDate("u1", dueDay, {
      initialCandidates: firstPage,
      initialCursor: { id: "page-1-last" } as never,
    });

    expect(h.getDocs).toHaveBeenCalledTimes(2);
    expect(firestore.startAfter).toHaveBeenNthCalledWith(2, page2.at(-1));
    expect(result.at(-1)?.workoutId).toBe("morning-candidate");
  });

  it("stops on a short page even when its oldest result has not crossed the boundary", async () => {
    const firstPage = workoutPage(
      "page-1",
      AUTO_MATCH_CANDIDATE_PAGE_SIZE,
      new Date(2026, 7, 3, 12)
    );
    h.getDocs.mockResolvedValueOnce({
      docs: [firestoreDocument("only-remaining", new Date(2026, 7, 2, 8))],
    });

    await fetchAutoMatchCandidatesThroughDate("u1", dueDay, {
      initialCandidates: firstPage,
      initialCursor: { id: "page-1-last" } as never,
    });

    expect(h.getDocs).toHaveBeenCalledTimes(1);
  });

  it("deduplicates workoutIds across the live and fetched pages", async () => {
    const firstPage = workoutPage(
      "page-1",
      AUTO_MATCH_CANDIDATE_PAGE_SIZE,
      new Date(2026, 7, 2, 12)
    );
    h.getDocs.mockResolvedValueOnce({
      docs: [
        firestoreDocument("duplicate-doc", new Date(2026, 7, 1, 9), "page-1-0"),
        firestoreDocument("new-candidate", new Date(2026, 7, 1, 8)),
      ],
    });

    const result = await fetchAutoMatchCandidatesThroughDate("u1", dueDay, {
      initialCandidates: firstPage,
      initialCursor: { id: "page-1-last" } as never,
    });

    expect(result.filter((candidate) => candidate.workoutId === "page-1-0"))
      .toHaveLength(1);
    expect(result).toHaveLength(AUTO_MATCH_CANDIDATE_PAGE_SIZE + 1);
  });
});

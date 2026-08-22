import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_PERFORMANCE_STORAGE_KEY } from "@/utils/clientPerformanceStore";

const h = vi.hoisted(() => ({
  firebaseSignOut: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {},
  signInWithPopup: vi.fn(),
  signOut: h.firebaseSignOut,
  onAuthStateChanged: vi.fn(),
}));
vi.mock("@/lib/firebase", () => ({ auth: { name: "auth" } }));

import { signOut } from "@/lib/auth";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
  window.localStorage.clear();
  h.firebaseSignOut.mockReset().mockResolvedValue(undefined);
});

describe("signOut", () => {
  it("clears local performance samples before signing out of Firebase", async () => {
    window.localStorage.setItem(CLIENT_PERFORMANCE_STORAGE_KEY, "[]");
    h.firebaseSignOut.mockImplementation(async () => {
      expect(
        window.localStorage.getItem(CLIENT_PERFORMANCE_STORAGE_KEY)
      ).toBeNull();
    });

    await signOut();

    expect(h.firebaseSignOut).toHaveBeenCalledTimes(1);
  });
});

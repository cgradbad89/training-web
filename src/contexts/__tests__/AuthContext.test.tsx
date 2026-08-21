import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type User } from "firebase/auth";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  listener: null as ((user: User | null) => void) | null,
  unsubscribe: vi.fn(),
  onAuthChange: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  onAuthChange: h.onAuthChange,
}));

import { AuthProvider, useAuthContext } from "@/contexts/AuthContext";

function Probe({ name }: { name: string }) {
  const { user, loading } = useAuthContext();
  return (
    <div data-testid={name}>
      {loading ? "loading" : user?.uid ?? "signed-out"}
    </div>
  );
}

describe("AuthProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    h.listener = null;
    h.unsubscribe.mockReset();
    h.onAuthChange.mockReset().mockImplementation((listener) => {
      h.listener = listener;
      return h.unsubscribe;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shares one Firebase observer across every useAuth consumer", () => {
    act(() => {
      root.render(
        <AuthProvider>
          <Probe name="first" />
          <Probe name="second" />
        </AuthProvider>
      );
    });

    expect(h.onAuthChange).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("loadingloading");

    act(() => h.listener?.({ uid: "resolved-uid" } as User));
    expect(container.textContent).toBe("resolved-uidresolved-uid");

    act(() => h.listener?.(null));
    expect(container.textContent).toBe("signed-outsigned-out");
  });

  it("unsubscribes the root observer when the provider unmounts", () => {
    act(() => {
      root.render(
        <AuthProvider>
          <Probe name="only" />
        </AuthProvider>
      );
    });

    act(() => root.unmount());
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);

    root = createRoot(container);
  });

  it("fails clearly when useAuth is called outside the root provider", () => {
    expect(() => {
      act(() => root.render(<Probe name="orphan" />));
    }).toThrow(/useAuth must be used within AuthProvider/);
  });
});

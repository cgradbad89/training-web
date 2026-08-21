import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  auth: { user: null as { uid: string } | null, loading: true },
  replace: vi.fn(),
}));

vi.mock("@/hooks", () => ({
  useAuth: () => h.auth,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock("@/components/ui/LoadingSpinner", () => ({
  FullPageLoader: () => <div data-testid="auth-loading" />,
}));

import { AuthGuard } from "../AuthGuard";

describe("AuthGuard resolved-auth handoff", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    h.auth = { user: null, loading: true };
    h.replace.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not render data providers while auth is unresolved", () => {
    act(() => {
      root.render(
        <AuthGuard>
          {() => <div data-testid="protected-provider" />}
        </AuthGuard>
      );
    });

    expect(container.querySelector('[data-testid="auth-loading"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="protected-provider"]')
    ).toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("hands the resolved authenticated user to its render child", () => {
    h.auth = { user: { uid: "resolved-uid" }, loading: false };
    act(() => {
      root.render(
        <AuthGuard>
          {({ user }) => <div data-testid="resolved-uid">{user.uid}</div>}
        </AuthGuard>
      );
    });

    expect(
      container.querySelector('[data-testid="resolved-uid"]')?.textContent
    ).toBe("resolved-uid");
  });

  it("does not render protected content for a resolved signed-out user", () => {
    h.auth = { user: null, loading: false };
    act(() => {
      root.render(
        <AuthGuard>
          {() => <div data-testid="protected-provider" />}
        </AuthGuard>
      );
    });

    expect(
      container.querySelector('[data-testid="protected-provider"]')
    ).toBeNull();
    expect(h.replace).toHaveBeenCalledWith("/login");
  });
});

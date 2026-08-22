import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  auth: {
    user: null as { uid: string } | null,
    loading: false,
    authorizationStatus: "signed-out",
    authorizationError: null as string | null,
  },
  replace: vi.fn(),
  signInWithGoogle: vi.fn(),
}));

vi.mock("@/hooks", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock("@/lib/auth", () => ({ signInWithGoogle: h.signInWithGoogle }));

import LoginPage from "../page";

describe("LoginPage authorization feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    h.auth.user = null;
    h.auth.loading = false;
    h.auth.authorizationStatus = "signed-out";
    h.auth.authorizationError = null;
    h.replace.mockReset();
    h.signInWithGoogle.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the minimal unauthorized-account error without disclosing the owner", () => {
    h.auth.authorizationStatus = "unauthorized";
    h.auth.authorizationError =
      "This account is not authorized to use Training Web.";

    act(() => root.render(<LoginPage />));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This account is not authorized to use Training Web."
    );
    expect(container.textContent).not.toContain("folstromjohn@gmail.com");
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("redirects only when AuthContext exposes an authorized owner", () => {
    h.auth.user = { uid: "owner" };
    h.auth.authorizationStatus = "authorized";

    act(() => root.render(<LoginPage />));

    expect(h.replace).toHaveBeenCalledWith("/dashboard");
  });
});

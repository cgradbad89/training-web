import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppAuthBoundary } from "../AppAuthBoundary";

const h = vi.hoisted(() => ({ pathname: "/race-confirmation-preview", imports: 0, mounts: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
vi.mock("@/contexts/AuthContext", () => {
  h.imports++;
  return { AuthProvider: ({ children }: { children: React.ReactNode }) => {
    h.mounts++;
    return <div data-testid="normal-auth-provider">{children}</div>;
  } };
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  h.pathname = "/race-confirmation-preview";
  h.mounts = 0;
  vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });
async function render() {
  await act(async () => { root.render(<AppAuthBoundary><p>Synthetic content</p></AppAuthBoundary>); });
}

describe("synthetic preview authentication isolation", () => {
  it("does not even import Firebase's provider on the opted-in synthetic route", async () => {
    await render();
    expect(container.textContent).toBe("Synthetic content");
    expect(h.imports).toBe(0);
    expect(h.mounts).toBe(0);
  });

  it.each(["/login", "/races", "/race-confirmation-preview/other"])("preserves the provider on %s", async pathname => {
    h.pathname = pathname;
    await render();
    expect(container.querySelector('[data-testid="normal-auth-provider"]')).not.toBeNull();
    expect(h.mounts).toBeGreaterThan(0);
  });

  it("cannot bypass authentication in Production even if opted in", async () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    await render();
    expect(h.mounts).toBeGreaterThan(0);
  });

  it("cannot bypass authentication when the preview feature is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "false");
    await render();
    expect(h.mounts).toBeGreaterThan(0);
  });
});

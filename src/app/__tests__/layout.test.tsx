import React, { act, type ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";

const h = vi.hoisted(() => ({
  listener: null as ((user: User | null) => void) | null,
  subscribe: vi.fn(), unsubscribe: vi.fn(), replace: vi.fn(),
}));
vi.mock("next/font/google", () => ({ Geist: () => ({ variable: "sans" }), Geist_Mono: () => ({ variable: "mono" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/auth", () => ({ onAuthChange: h.subscribe, signOut: vi.fn() }));
vi.mock("@/utils/routeCache", () => ({ setRouteCacheSession: vi.fn() }));
vi.mock("@/hooks", () => ({ useAuth: () => useAuthContext() }));

import RootLayout from "../layout";
import { AuthProvider, useAuthContext } from "@/contexts/AuthContext";
import { AuthGuard } from "@/components/layout/AuthGuard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function applicationTree(page: string) {
  const layout = RootLayout({ children: <AuthGuard><p>{page}</p></AuthGuard> });
  const body = (layout.props.children as ReactElement[]).find(element => element.type === "body")!;
  return (body.props as { children: ReactElement }).children;
}

describe("root authentication shell continuity", () => {
  it.each(["production", "preview"])("hydrates and retains one eager owner session across navigation in %s", async deployment => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", deployment);
    h.listener = null;
    h.subscribe.mockImplementation(listener => { h.listener = listener; return h.unsubscribe; });
    const tree = applicationTree("Races");
    expect(tree.type).toBe(AuthProvider);
    const html = renderToString(tree);
    expect(html).not.toContain("Races");
    expect(h.subscribe).not.toHaveBeenCalled();
    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const hydrationError = vi.fn();
    await act(async () => { root = hydrateRoot(container!, tree, { onRecoverableError: hydrationError }); });
    expect(hydrationError).not.toHaveBeenCalled();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();

    act(() => h.listener?.({ uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true } as User));
    expect(container.textContent).toBe("Races");
    act(() => root!.render(applicationTree("Workouts")));
    expect(container.textContent).toBe("Workouts");
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();

    act(() => h.listener?.(null));
    expect(container.textContent).not.toContain("Workouts");
    expect(h.replace).toHaveBeenLastCalledWith("/login");
    act(() => root!.unmount()); root = undefined;
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

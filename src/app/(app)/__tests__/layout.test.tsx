import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AppLayout from "../layout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/layout/AuthGuard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/layout/HubBanner", () => ({
  HubBanner: () => <div data-testid="hub-banner" />,
}));
vi.mock("@/components/layout/MobileTabBar", () => ({
  MobileTabBar: () => <div data-testid="mobile-tabs" />,
}));
vi.mock("@/contexts/AppDataContext", () => ({
  AppDataProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-data-provider">{children}</div>
  ),
}));
vi.mock("@/components/AutoMatchRunner", () => ({
  default: () => <div data-testid="auto-match-runner" />,
}));
vi.mock("@/components/PRComputerRunner", () => ({
  default: () => <div data-testid="pr-computer-runner" />,
}));

describe("authenticated app layout training-data scope", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderAt(pathname: string) {
    h.pathname = pathname;
    act(() => {
      root.render(
        <AppLayout>
          <div data-testid="page-content" />
        </AppLayout>
      );
    });
  }

  it("does not mount training data or runners on /health", () => {
    renderAt("/health");

    expect(container.querySelector('[data-testid="page-content"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="app-data-provider"]')).toBeNull();
    expect(container.querySelector('[data-testid="auto-match-runner"]')).toBeNull();
    expect(container.querySelector('[data-testid="pr-computer-runner"]')).toBeNull();
  });

  it("also excludes descendant Health routes", () => {
    renderAt("/health/trends");

    expect(container.querySelector('[data-testid="app-data-provider"]')).toBeNull();
    expect(container.querySelector('[data-testid="auto-match-runner"]')).toBeNull();
    expect(container.querySelector('[data-testid="pr-computer-runner"]')).toBeNull();
  });

  it("keeps the provider and both runners on Dashboard", () => {
    renderAt("/dashboard");

    expect(container.querySelector('[data-testid="app-data-provider"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="auto-match-runner"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pr-computer-runner"]')).toBeTruthy();
  });

  it("keeps the provider and both runners on Workouts", () => {
    renderAt("/workouts");

    expect(container.querySelector('[data-testid="app-data-provider"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="auto-match-runner"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pr-computer-runner"]')).toBeTruthy();
  });
});

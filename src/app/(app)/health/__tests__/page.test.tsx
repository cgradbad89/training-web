import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import HealthPage from "../page";
import * as healthMetricsService from "@/services/healthMetrics";
import * as authHook from "@/hooks/useAuth";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const localStorageValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
    removeItem: (key: string) => localStorageValues.delete(key),
    clear: () => localStorageValues.clear(),
  },
});

// Mocks
vi.mock("@/services/healthMetrics", async () => {
  const actual = await vi.importActual("@/services/healthMetrics");
  return {
    ...actual,
    fetchHealthMetrics: vi.fn(),
    onHealthMetricsSnapshot: vi.fn(),
    fetchHourlyHeartRate: vi.fn(),
    fetchHealthGoals: vi.fn(),
    fetchAllHealthMetrics: vi.fn(),
    fetchHealthMetricsRange: vi.fn(),
  };
});

vi.mock("@/services/healthGoals", () => ({
  fetchHealthGoals: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));
const flushPage = async () => {
  await flushPromises();
  await flushPromises();
  await flushPromises();
};

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) {
    throw new Error(
      `Button not found: ${text}\n${container.innerHTML.slice(0, 500)}`
    );
  }
  return button;
}

async function renderPage(root: Root) {
  await act(async () => {
    root.render(<HealthPage />);
  });
  await act(async () => {
    await flushPage();
  });
}

async function clickButton(container: HTMLElement, text: string) {
  await act(async () => {
    buttonWithText(container, text).click();
  });
  await act(async () => {
    await flushPage();
  });
}

describe("Health Dashboard Page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    (authHook.useAuth as any).mockReturnValue({ user: { uid: "test-user-123" }, loading: false });
    (healthMetricsService.fetchHealthMetrics as any).mockResolvedValue([{ date: "2026-07-17", weight_lbs: 160 }]);
    (healthMetricsService.fetchHourlyHeartRate as any).mockResolvedValue(null);
    (healthMetricsService.fetchHealthGoals as any).mockResolvedValue(null);
    (healthMetricsService.fetchAllHealthMetrics as any).mockResolvedValue([]);
    (healthMetricsService.fetchHealthMetricsRange as any).mockResolvedValue([]);
    (healthMetricsService.onHealthMetricsSnapshot as any).mockReturnValue(vi.fn());
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("does not create an onSnapshot subscription for healthMetrics", async () => {
    await act(async () => {
      root.render(<HealthPage />);
    });
    await act(async () => { await flushPromises(); await flushPromises(); await flushPromises(); });
    
    expect(healthMetricsService.onHealthMetricsSnapshot).not.toHaveBeenCalled();
  });

  it("calls fetchHealthMetrics once on mount", async () => {
    await act(async () => {
      root.render(<HealthPage />);
    });
    await act(async () => { await flushPromises(); await flushPromises(); await flushPromises(); });
    
    expect(healthMetricsService.fetchHealthMetrics).toHaveBeenCalledWith("test-user-123", 90);
    expect(healthMetricsService.fetchHealthMetrics).toHaveBeenCalledTimes(1);
  });

  it("calls fetchHealthMetrics again when manual refresh is clicked", async () => {
    await act(async () => {
      root.render(<HealthPage />);
    });
    await act(async () => { await flushPromises(); await flushPromises(); await flushPromises(); });
    
    expect(healthMetricsService.fetchHealthMetrics).toHaveBeenCalledTimes(1);

    const refreshButton = container.querySelector("button[aria-label='Refresh metrics']");
    expect(refreshButton).toBeTruthy();

    await act(async () => {
      refreshButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    
    await act(async () => { await flushPromises(); await flushPromises(); await flushPromises(); });

    expect(healthMetricsService.fetchHealthMetrics).toHaveBeenCalledTimes(2);
  });

  it("does not fetch a persisted YTD Trends range before Trends is active", async () => {
    window.localStorage.setItem("health_time_range", "ytd");
    await renderPage(root);

    expect(healthMetricsService.fetchHealthMetricsRange).not.toHaveBeenCalled();
    expect(healthMetricsService.fetchAllHealthMetrics).not.toHaveBeenCalled();
  });

  it("fetches YTD with a January 1 through local-today range on Trends", async () => {
    window.localStorage.setItem("health_time_range", "ytd");
    const today = localIsoDate(new Date());
    await renderPage(root);
    await clickButton(container, "Trends");

    expect(healthMetricsService.fetchHealthMetricsRange).toHaveBeenCalledWith(
      "test-user-123",
      `${today.slice(0, 4)}-01-01`,
      today
    );
    expect(healthMetricsService.fetchAllHealthMetrics).not.toHaveBeenCalled();
  });

  it("keeps All on the existing full-history query and waits for Trends", async () => {
    window.localStorage.setItem("health_time_range", "all");
    await renderPage(root);
    expect(healthMetricsService.fetchAllHealthMetrics).not.toHaveBeenCalled();
    await clickButton(container, "Trends");

    expect(healthMetricsService.fetchAllHealthMetrics).toHaveBeenCalledWith(
      "test-user-123"
    );
    expect(healthMetricsService.fetchHealthMetricsRange).not.toHaveBeenCalled();
  });

  it("retries a failed YTD fetch when Trends is selected again", async () => {
    window.localStorage.setItem("health_time_range", "ytd");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (healthMetricsService.fetchHealthMetricsRange as any)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce([]);
    await renderPage(root);
    await clickButton(container, "Trends");
    await clickButton(container, "Today");
    await clickButton(container, "Trends");

    expect(healthMetricsService.fetchHealthMetricsRange).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a successful YTD fetch when revisiting Trends", async () => {
    window.localStorage.setItem("health_time_range", "ytd");
    await renderPage(root);
    await clickButton(container, "Trends");
    await clickButton(container, "Today");
    await clickButton(container, "Trends");

    expect(healthMetricsService.fetchHealthMetricsRange).toHaveBeenCalledTimes(1);
  });

  it("retries a failed All fetch and stops after success", async () => {
    window.localStorage.setItem("health_time_range", "all");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (healthMetricsService.fetchAllHealthMetrics as any)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce([]);
    await renderPage(root);
    await clickButton(container, "Trends");
    await clickButton(container, "Today");
    await clickButton(container, "Trends");
    await clickButton(container, "Today");
    await clickButton(container, "Trends");

    expect(healthMetricsService.fetchAllHealthMetrics).toHaveBeenCalledTimes(2);
  });
});

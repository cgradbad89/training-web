import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import HealthPage from "../page";
import * as healthMetricsService from "@/services/healthMetrics";
import * as authHook from "@/hooks/useAuth";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const localStorageValues = new Map<string, string>();
const focus = vi.hoisted(() => ({
  refetch: null as null | (() => Promise<void> | void),
}));
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

vi.mock("@/hooks/useRefetchOnFocus", () => ({
  useRefetchOnFocus: (refetch: () => Promise<void> | void) => {
    focus.refetch = refetch;
  },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return localIsoDate(new Date(year, month - 1, day + days));
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

async function clickAriaLabel(container: HTMLElement, label: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label='${label}']`
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
  await act(async () => flushPage());
}

describe("Health Dashboard Page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Keep calendar/cache expectations tied to an explicit local calendar day
    // instead of whichever date the test process happens to run. Local noon
    // represents the same intended day in every host timezone.
    vi.setSystemTime(new Date(2026, 7, 29, 12));
    vi.clearAllMocks();
    focus.refetch = null;
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
    vi.useRealTimers();
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

  it("shows the skeleton only for the initial load and preserves content during a background refresh", async () => {
    const initial = deferred<healthMetricsService.HealthMetric[]>();
    vi.mocked(healthMetricsService.fetchHealthMetrics).mockReturnValueOnce(
      initial.promise
    );

    await act(async () => root.render(<HealthPage />));
    expect(container.querySelector("[aria-label='Loading health']")).toBeTruthy();

    initial.resolve([{ date: "2026-07-17", weight_lbs: 160 }]);
    await act(async () => flushPage());
    expect(container.textContent).toContain("Health");
    expect(container.querySelector("[aria-label='Loading health']")).toBeNull();

    const background = deferred<healthMetricsService.HealthMetric[]>();
    vi.mocked(healthMetricsService.fetchHealthMetrics).mockReturnValueOnce(
      background.promise
    );
    act(() => {
      void focus.refetch?.();
    });

    expect(container.textContent).toContain("Health");
    expect(container.querySelector("[aria-label='Loading health']")).toBeNull();
    background.resolve([{ date: "2026-07-18", weight_lbs: 161 }]);
    await act(async () => flushPage());
  });

  it("reuses the in-flight Health metrics promise for overlapping focus refreshes", async () => {
    await renderPage(root);
    const background = deferred<healthMetricsService.HealthMetric[]>();
    vi.mocked(healthMetricsService.fetchHealthMetrics).mockReturnValueOnce(
      background.promise
    );

    let first!: Promise<void> | void;
    let second!: Promise<void> | void;
    act(() => {
      first = focus.refetch?.();
      second = focus.refetch?.();
    });

    expect(first).toBe(second);
    expect(healthMetricsService.fetchHealthMetrics).toHaveBeenCalledTimes(2);
    background.resolve([]);
    await act(async () => first);
  });

  it("keeps existing Health content when a background refresh fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderPage(root);
    const background = deferred<healthMetricsService.HealthMetric[]>();
    vi.mocked(healthMetricsService.fetchHealthMetrics).mockReturnValueOnce(
      background.promise
    );

    act(() => {
      void focus.refetch?.();
    });
    background.reject(new Error("temporary refresh failure"));
    await act(async () => flushPage());

    expect(container.textContent).toContain("Health");
    expect(container.textContent).not.toContain("Error loading health data");
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

    const cutoff = healthMetricsService.healthMetricsCutoffISO(90);
    expect(healthMetricsService.fetchHealthMetricsRange).toHaveBeenCalledWith(
      "test-user-123",
      `${today.slice(0, 4)}-01-01`,
      shiftIsoDate(cutoff, -1)
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

  it("does not fetch Calendar dates already covered by the rolling metrics query", async () => {
    await renderPage(root);
    await clickButton(container, "Calendar");
    await clickButton(container, "Month");

    expect(healthMetricsService.fetchHealthMetricsRange).not.toHaveBeenCalled();
  });

  it.each([
    {
      localDate: new Date(2026, 7, 30, 12),
      cutoff: "2026-06-01",
      expectedGap: null,
    },
    {
      localDate: new Date(2026, 7, 31, 12),
      cutoff: "2026-06-02",
      expectedGap: ["2026-06-01", "2026-06-01"],
    },
    {
      localDate: new Date(2026, 8, 1, 12),
      cutoff: "2026-06-03",
      expectedGap: ["2026-06-01", "2026-06-02"],
    },
  ])(
    "requests only the uncovered cutoff-month gap on $cutoff",
    async ({ localDate, cutoff, expectedGap }) => {
      vi.setSystemTime(localDate);
      await renderPage(root);
      await clickButton(container, "Calendar");
      await clickButton(container, "Month");

      expect(healthMetricsService.healthMetricsCutoffISO(90)).toBe(cutoff);
      const now = new Date();
      const [cutoffYear, cutoffMonth] = cutoff.split("-").map(Number);
      const monthsBack =
        now.getFullYear() * 12 + now.getMonth() -
        (cutoffYear * 12 + cutoffMonth - 1);
      for (let index = 0; index < monthsBack; index += 1) {
        await clickAriaLabel(container, "Previous month");
      }

      if (expectedGap === null) {
        expect(healthMetricsService.fetchHealthMetricsRange).not.toHaveBeenCalled();
      } else {
        expect(healthMetricsService.fetchHealthMetricsRange).toHaveBeenLastCalledWith(
          "test-user-123",
          ...expectedGap
        );
      }
    }
  );

  it("fetches a fully uncovered Calendar month as one whole-month gap", async () => {
    await renderPage(root);
    await clickButton(container, "Calendar");
    await clickButton(container, "Month");

    const now = new Date();
    const cutoff = healthMetricsService.healthMetricsCutoffISO(90);
    const [cutoffYear, cutoffMonth] = cutoff.split("-").map(Number);
    const monthsBack =
      now.getFullYear() * 12 + now.getMonth() -
      (cutoffYear * 12 + cutoffMonth - 1);
    for (let index = 0; index < monthsBack; index += 1) {
      await clickAriaLabel(container, "Previous month");
    }
    vi.mocked(healthMetricsService.fetchHealthMetricsRange).mockClear();

    await clickAriaLabel(container, "Previous month");
    const previousMonth = new Date(cutoffYear, cutoffMonth - 2, 1);
    const previousMonthStart = localIsoDate(previousMonth);
    const previousMonthEnd = localIsoDate(
      new Date(previousMonth.getFullYear(), previousMonth.getMonth() + 1, 0)
    );
    expect(healthMetricsService.fetchHealthMetricsRange).toHaveBeenCalledWith(
      "test-user-123",
      previousMonthStart,
      previousMonthEnd
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import HealthPage from "../page";
import * as healthMetricsService from "@/services/healthMetrics";
import * as authHook from "@/hooks/useAuth";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mocks
vi.mock("@/services/healthMetrics", async () => {
  const actual = await vi.importActual("@/services/healthMetrics");
  return {
    ...actual,
    fetchHealthMetrics: vi.fn(),
    onHealthMetricsSnapshot: vi.fn(),
    fetchHourlyHeartRate: vi.fn(),
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
    (healthMetricsService.fetchAllHealthMetrics as any).mockResolvedValue([]);
    (healthMetricsService.onHealthMetricsSnapshot as any).mockReturnValue(vi.fn());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
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
});

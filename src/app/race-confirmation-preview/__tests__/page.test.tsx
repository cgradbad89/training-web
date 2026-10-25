import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RaceConfirmationPreviewPage from "../page";

const h = vi.hoisted(() => ({ imports: 0 }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/components/races/RaceConfirmationPreview", () => {
  h.imports++;
  return { RaceConfirmationPreview: () => <div>Synthetic preview</div> };
});
afterEach(() => vi.unstubAllEnvs());

describe("synthetic confirmation route deployment gate", () => {
  it.each([undefined, "false", "1", "TRUE"])("does not load a preview without exact opt-in: %s", async flag => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", flag);
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
    await expect(RaceConfirmationPreviewPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.imports).toBe(0);
  });

  it("returns not-found before loading the client preview in Production", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    await expect(RaceConfirmationPreviewPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.imports).toBe(0);
  });

  it("loads the synthetic client only in an opted-in preview", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
    const element = await RaceConfirmationPreviewPage();
    expect(React.isValidElement(element)).toBe(true);
    expect(h.imports).toBe(1);
  });
});

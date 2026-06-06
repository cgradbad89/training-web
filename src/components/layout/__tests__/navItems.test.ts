import { describe, it, expect } from "vitest";
import {
  NAV_ITEMS,
  PRIMARY_MOBILE_ITEMS,
  PRIMARY_MOBILE_HREFS,
  SECONDARY_MOBILE_ITEMS,
} from "@/components/layout/navItems";

// These tests guard the single nav source of truth: the desktop sidebar
// (NAV_ITEMS) and the mobile tab bar (primary 4) + "More" sheet (secondary)
// must always partition the SAME set of destinations — no drift, no dupes,
// no omissions.

const EXPECTED_HREFS = [
  "/dashboard",
  "/plan-insights",
  "/personal-insights",
  "/health",
  "/workouts",
  "/runs",
  "/routes",
  "/plans",
  "/races",
  "/shoes",
  "/coach",
  "/settings",
];

describe("navItems", () => {
  it("NAV_ITEMS contains exactly the expected destinations (no dupes)", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length); // no duplicates
    expect([...hrefs].sort()).toEqual([...EXPECTED_HREFS].sort());
  });

  it("every nav item has a non-empty label and an icon component", () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
    }
  });

  it("declares exactly 4 primary mobile tabs", () => {
    expect(PRIMARY_MOBILE_HREFS).toHaveLength(4);
    expect(PRIMARY_MOBILE_ITEMS).toHaveLength(4);
  });

  it("every primary href resolves to a real NAV_ITEMS entry (same label/icon)", () => {
    for (const item of PRIMARY_MOBILE_ITEMS) {
      const source = NAV_ITEMS.find((i) => i.href === item.href);
      expect(source).toBeDefined();
      // Derived from the same array → identical reference, so no drift.
      expect(item).toBe(source);
    }
  });

  it("primary + secondary partition NAV_ITEMS with no overlap or omission", () => {
    const primary = PRIMARY_MOBILE_ITEMS.map((i) => i.href);
    const secondary = SECONDARY_MOBILE_ITEMS.map((i) => i.href);

    // No item appears in both partitions.
    const overlap = primary.filter((h) => secondary.includes(h));
    expect(overlap).toEqual([]);

    // Union equals the full nav set, with no missing or extra items.
    const union = [...primary, ...secondary].sort();
    expect(union).toEqual(NAV_ITEMS.map((i) => i.href).sort());
    expect(union).toHaveLength(NAV_ITEMS.length);
  });

  it("primary order matches PRIMARY_MOBILE_HREFS", () => {
    expect(PRIMARY_MOBILE_ITEMS.map((i) => i.href)).toEqual(PRIMARY_MOBILE_HREFS);
  });
});

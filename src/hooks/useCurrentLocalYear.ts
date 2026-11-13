"use client";

import { useEffect, useState } from "react";

/** Slack added past local midnight so an early-firing timer still sees the new day. */
const MIDNIGHT_BUFFER_MS = 100;

function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, next.getTime() - now.getTime()) + MIDNIGHT_BUFFER_MS;
}

/**
 * Returns the current device-local year and re-renders when it changes.
 * Re-checks on window 'focus' and document 'visibilitychange', and via a
 * timeout scheduled for the next local midnight (re-armed after it fires).
 * Cleans up all listeners and timers on unmount.
 */
export function useCurrentLocalYear(): number {
  const [year, setYear] = useState<number>(() => new Date().getFullYear());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      setYear(new Date().getFullYear());
    };

    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        check();
        arm();
      }, msUntilNextLocalMidnight(new Date()));
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      check();
      arm();
    };
    const onFocus = () => {
      check();
      arm();
    };

    // Catch a rollover that happened between render and effect.
    check();
    arm();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return year;
}

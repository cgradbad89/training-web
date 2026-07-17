import { useEffect, useRef } from "react";

/**
 * Re-runs `refetchFn` when the tab regains visibility, unless the last
 * refetch happened more recently than `minIntervalMs` (default 30s) — avoids
 * spamming reads on rapid tab-switching.
 */
export function useRefetchOnFocus(
  refetchFn: () => Promise<void> | void,
  minIntervalMs: number = 30000
): void {
  const refetchRef = useRef(refetchFn);
  refetchRef.current = refetchFn;
  const lastRunRef = useRef<number>(Date.now());

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRunRef.current < minIntervalMs) return;
      lastRunRef.current = now;
      void refetchRef.current();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [minIntervalMs]);
}

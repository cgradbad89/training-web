import { useEffect, useEffectEvent, useRef, useState } from "react";

/**
 * Re-runs `refetchFn` when the tab regains visibility, unless the last
 * refetch happened more recently than `minIntervalMs` (default 30s) — avoids
 * spamming reads on rapid tab-switching.
 */
export function useRefetchOnFocus(
  refetchFn: () => Promise<void> | void,
  minIntervalMs: number = 30000
): void {
  const refetch = useEffectEvent(refetchFn);
  const [initialRunAt] = useState(Date.now);
  const lastRunRef = useRef(initialRunAt);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRunRef.current < minIntervalMs) return;
      lastRunRef.current = now;
      void refetch();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [minIntervalMs]);
}

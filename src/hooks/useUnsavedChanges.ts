import { useEffect, useState, useCallback, useRef } from "react";

/**
 * Warns the user when they try to navigate away while in edit mode.
 *
 * - Adds a `beforeunload` listener when `isDirty` is true (protects against
 *   browser close / hard refresh).
 * - Intercepts `history.pushState` to catch in-app navigation (sidebar links,
 *   router.push calls) and surface a confirmation dialog.
 *
 * Returns state and handlers so the caller can render a ConfirmDialog:
 *   showNavWarning  – whether to show the dialog
 *   confirmNav      – user chose to leave; completes the pending navigation
 *   cancelNav       – user chose to stay; discards the pending navigation
 *   guardNavigation – wrap an explicit navigation call (e.g. router.back())
 *                     so it also triggers the dialog when dirty
 */
export function useUnsavedChanges(isDirty: boolean): {
  showNavWarning: boolean;
  confirmNav: () => void;
  cancelNav: () => void;
  guardNavigation: (fn: () => void) => void;
} {
  const pendingNavRef = useRef<(() => void) | null>(null);
  const [showNavWarning, setShowNavWarning] = useState(false);

  // Keep a ref so guardNavigation always reads the latest isDirty value without
  // needing to be in the dependency array.
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // 1. Browser beforeunload — warns on tab close / hard refresh
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // 2. Intercept in-app navigation via history.pushState.
  //    Next.js App Router calls pushState as part of client-side navigation
  //    (sidebar Links, router.push). We capture the pending call and show the
  //    dialog instead of allowing the navigation to proceed immediately.
  useEffect(() => {
    if (!isDirty) return;

    const orig = window.history.pushState.bind(window.history);

    window.history.pushState = function (
      data: unknown,
      unused: string,
      url?: string | URL | null
    ) {
      // Store what we would have done so we can execute it on confirm.
      pendingNavRef.current = () => {
        // Restore the real pushState before executing so subsequent navigations
        // after confirmation are not intercepted again.
        window.history.pushState = orig;
        orig(data, unused, url);
      };
      setShowNavWarning(true);
    };

    return () => {
      // Restore on cleanup (isDirty → false, or component unmount).
      window.history.pushState = orig;
      pendingNavRef.current = null;
    };
  }, [isDirty]);

  const confirmNav = useCallback(() => {
    const pending = pendingNavRef.current;
    pendingNavRef.current = null;
    setShowNavWarning(false);
    pending?.();
  }, []);

  const cancelNav = useCallback(() => {
    pendingNavRef.current = null;
    setShowNavWarning(false);
  }, []);

  /**
   * Wraps an explicit navigation call (e.g. `router.back()`) that doesn't go
   * through pushState. When dirty, shows the dialog; otherwise calls fn directly.
   */
  const guardNavigation = useCallback((fn: () => void) => {
    if (isDirtyRef.current) {
      pendingNavRef.current = fn;
      setShowNavWarning(true);
    } else {
      fn();
    }
  }, []);

  return { showNavWarning, confirmNav, cancelNav, guardNavigation };
}

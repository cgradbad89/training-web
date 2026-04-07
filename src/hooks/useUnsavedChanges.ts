import { useEffect } from "react";

/**
 * Warns the user when they try to close/navigate away with unsaved changes.
 * Adds a `beforeunload` listener when `isDirty` is true.
 */
export function useUnsavedChanges(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);
}

"use client";

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/** Accessible modal following the app's ManualActivityModal pattern: focus on
 * open, Tab containment, Escape/backdrop/close button, focus return and body
 * scroll lock. Bottom sheet on phones (safe-area aware), centered on desktop.
 * It renders only its children; it acquires and processes nothing. */
export function EstimateDetailsDialog({ title, onClose, returnFocusRef, children }: {
  title: string;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = `${useId()}-title`;
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const returnTarget = returnFocusRef?.current ?? previousFocus;
    headingRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialogRef.current.contains(active);
      if (event.shiftKey && (!inside || active === first || active === headingRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || active === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnTarget?.focus?.();
    };
  }, [returnFocusRef]);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 md:items-center md:p-4"
      onClick={() => onCloseRef.current()} data-testid="estimate-details-backdrop">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="estimate-details-dialog"
        className="flex h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] w-full min-w-0 max-w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl md:h-auto md:max-h-[90vh] md:max-w-3xl md:rounded-2xl"
        onClick={event => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="min-w-0 text-base font-semibold text-textPrimary outline-none">{title}</h2>
          <button type="button" onClick={() => onCloseRef.current()} aria-label="Close estimate details"
            className="shrink-0 rounded-lg p-2 text-textSecondary transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] break-words sm:px-5">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

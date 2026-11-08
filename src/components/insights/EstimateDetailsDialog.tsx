"use client";

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
export const INSIGHTS_DIALOG_TRIGGER_CLASS = "inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm font-semibold text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** Safe-area-aware sheet on phones and centered dialog on desktop. */
export function InsightsDialog({ title, testId, onClose, returnFocusRef, dismissalMessage, children }: {
  title: string;
  testId: string;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  dismissalMessage?: string;
  children: React.ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = `${useId()}-title`;
  const dismissalId = `${titleId}-dismissal`;
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const returnTarget = returnFocusRef?.current ?? previousFocus;
    headingRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const background = [...document.body.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== backdropRef.current && !element.inert);
    for (const element of background) element.inert = true;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => {
        if (element.closest("[hidden], [inert]")) return false;
        // An inner summary can itself be hidden by an outer collapsed comparison.
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.matches("details:not([open])") && !ancestor.querySelector(":scope > summary")?.contains(element)) return false;
        }
        return true;
      });
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
      for (const element of background) element.inert = false;
      returnTarget?.focus?.();
    };
  }, [returnFocusRef]);

  return createPortal(
    <div ref={backdropRef} className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 md:items-center md:p-4"
      onClick={event => { if (event.target === event.currentTarget) onCloseRef.current(); }} data-testid={`${testId}-backdrop`}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={`${testId}-dialog`}
        className="flex h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] w-full min-w-0 max-w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl md:h-auto md:max-h-[90vh] md:max-w-3xl md:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-base font-semibold text-textPrimary outline-none">{title}</h2>
            {dismissalMessage && <p id={dismissalId} role="status" className="text-xs text-textSecondary">{dismissalMessage}</p>}
          </div>
          <button type="button" onClick={() => onCloseRef.current()} aria-label={`Close ${title.toLowerCase()}`}
            aria-disabled={dismissalMessage ? true : undefined} aria-describedby={dismissalMessage ? dismissalId : undefined}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-textSecondary transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
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

export function EstimateDetailsButton({ buttonRef, open, onClick }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClick: () => void;
}) {
  return <button ref={buttonRef} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={onClick}
    data-testid="view-estimate-details" className={INSIGHTS_DIALOG_TRIGGER_CLASS}>View Estimate Details</button>;
}

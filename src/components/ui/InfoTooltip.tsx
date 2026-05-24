"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";

/**
 * Small "what is this?" affordance for KPIs and metric labels.
 *
 * Behaviour:
 *   - Hover (desktop) AND click/tap (touch + keyboard) reveal the tooltip.
 *   - Outside click, Escape, blur, or mouse-leave dismiss it.
 *   - Keyboard accessible: <button> trigger with `aria-label`, focus ring.
 *   - Rendered with `position: fixed` + z-index 9999 so it escapes any
 *     parent `overflow-hidden` clipping (same pattern as TrainingLoadBadge).
 *   - Horizontal position auto-flips to keep the tooltip inside the viewport.
 *
 * Visual style mirrors the in-app tooltip palette: card background, border,
 * shadow, rounded corners, secondary-text body.
 */
interface InfoTooltipProps {
  /** Tooltip body text or rich content. */
  content: React.ReactNode;
  /** Accessible label for the trigger button. */
  ariaLabel: string;
  /** Icon pixel size (defaults to 13 — visually balanced next to xs labels). */
  size?: number;
  /** Tooltip max width in px (defaults to 260). */
  widthPx?: number;
}

interface AnchorPosition {
  /** Viewport y for the bottom of the tooltip (i.e. just above the icon). */
  top: number;
  /** Viewport x for the horizontal centre of the icon. */
  left: number;
}

export function InfoTooltip({
  content,
  ariaLabel,
  size = 13,
  widthPx = 260,
}: InfoTooltipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<AnchorPosition | null>(null);
  // Click/tap pins the tooltip open until dismissed; hover only shows it
  // while the cursor is over the trigger or tooltip.
  const [pinned, setPinned] = useState(false);
  const tooltipId = useId();

  function computePos(): AnchorPosition | null {
    if (!triggerRef.current) return null;
    const r = triggerRef.current.getBoundingClientRect();
    return { top: r.top - 8, left: r.left + r.width / 2 };
  }

  function open(viaPin: boolean) {
    setPos(computePos());
    if (viaPin) setPinned(true);
  }

  function close() {
    setPos(null);
    setPinned(false);
  }

  // Outside-click / Escape dismissal for the pinned state.
  useEffect(() => {
    if (!pinned) return;

    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        tooltipRef.current?.contains(t)
      ) {
        return;
      }
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  // Clamp the tooltip horizontally so it never overflows the viewport edge.
  // Computed from `pos` + `widthPx` at render time.
  let clampedStyle: React.CSSProperties = {};
  if (pos) {
    const margin = 8;
    const halfW = widthPx / 2;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
    const minLeft = halfW + margin;
    const maxLeft = vw - halfW - margin;
    const clampedLeft = Math.min(Math.max(pos.left, minLeft), maxLeft);
    clampedStyle = {
      position: "fixed",
      top: pos.top,
      left: clampedLeft,
      width: widthPx,
      transform: "translate(-50%, -100%)",
      zIndex: 9999,
    };
  }

  return (
    <span className="relative inline-flex items-center">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={pos != null}
        aria-describedby={pos != null ? tooltipId : undefined}
        // Hover: open un-pinned. Click: toggle pinned. Focus: open un-pinned.
        // Blur dismisses an un-pinned tooltip but leaves a pinned one alone.
        onMouseEnter={() => !pinned && open(false)}
        onMouseLeave={() => !pinned && close()}
        onFocus={() => !pinned && open(false)}
        onBlur={() => !pinned && close()}
        onClick={(e) => {
          e.stopPropagation();
          if (pinned) {
            close();
          } else {
            open(true);
          }
        }}
        className="ml-1 inline-flex items-center justify-center text-textSecondary hover:text-textPrimary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full cursor-help"
      >
        <Info size={size} aria-hidden="true" />
      </button>

      {pos && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={clampedStyle}
          className="bg-card border border-border rounded-lg p-3 shadow-lg text-[11px] leading-snug text-textSecondary text-left"
          onMouseEnter={() => !pinned && open(false)}
          onMouseLeave={() => !pinned && close()}
        >
          {content}
        </div>
      )}
    </span>
  );
}

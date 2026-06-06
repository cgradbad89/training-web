"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal, X } from "lucide-react";
import {
  PRIMARY_MOBILE_ITEMS,
  SECONDARY_MOBILE_ITEMS,
} from "@/components/layout/navItems";

// ─── "More" bottom sheet ──────────────────────────────────────────────────────
// Lists every nav item NOT in the primary tabs. Closes on item tap, backdrop
// tap, and Escape. Plain fixed-overlay + state (no new dependency). The
// open/close effect is declared BEFORE the early return so hooks run on every
// render (avoids React error #310).
function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="lg:hidden fixed inset-0 z-[60] bg-black/50 flex flex-col justify-end"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="More navigation"
    >
      <div
        className="bg-card border-t border-border rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-border">
          <h2 className="text-sm font-semibold text-textPrimary">More</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 -mr-2 flex items-center justify-center text-textSecondary hover:text-textPrimary rounded-lg"
          >
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {SECONDARY_MOBILE_ITEMS.map(({ href, label, icon: Icon }) => {
            const active =
              pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`flex items-center gap-3 px-3 rounded-xl text-sm font-medium transition-colors min-h-[48px] ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-textPrimary hover:bg-surface"
                }`}
              >
                <Icon size={18} />
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Mobile bottom tab bar ────────────────────────────────────────────────────
// Shown only below the lg breakpoint (lg:hidden). Renders the 4 primary tabs +
// a "More" tab that opens the sheet above. Desktop (>= lg) never renders this.
export function MobileTabBar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // If a secondary item is active, light up "More" so the user has a visual
  // anchor on which area of the app they're in.
  const inSecondary = SECONDARY_MOBILE_ITEMS.some(
    ({ href }) => pathname === href || pathname.startsWith(href + "/")
  );

  return (
    <>
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary"
      >
        {PRIMARY_MOBILE_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[56px] py-2 transition-colors ${
                active ? "text-primary" : "text-textSecondary"
              }`}
            >
              <Icon size={22} />
              <span className="text-[10px] font-medium leading-none">
                {label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More"
          aria-expanded={moreOpen}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[56px] py-2 transition-colors ${
            moreOpen || inSecondary ? "text-primary" : "text-textSecondary"
          }`}
        >
          <MoreHorizontal size={22} />
          <span className="text-[10px] font-medium leading-none">More</span>
        </button>
      </nav>

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}

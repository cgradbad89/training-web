/**
 * HubBanner — thin top bar linking to sibling hub apps.
 * Shows active state for Training and provides sign-out.
 */
"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks";
import { signOut } from "@/lib/auth";

const NAV_LINKS = [
  { label: "Hub", href: process.env.NEXT_PUBLIC_HUB_URL ?? "#" },
  { label: "Budget", href: "https://budget-web-xi.vercel.app" },
  { label: "Oracle", href: "https://oracle-web-pied.vercel.app" },
  { label: "DC Catz", href: "https://dc-catz.vercel.app" },
];

export function HubBanner() {
  const { user } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.push("/login");
    } catch (err) {
      console.error("Sign-out failed:", err);
      setSigningOut(false);
    }
  }

  return (
    <div className="bg-card border-b border-border h-10 flex items-center justify-between px-6 shrink-0">
      {/* Left: nav links */}
      <div className="flex items-center gap-6">
        {NAV_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="text-xs font-medium text-textSecondary hover:text-textPrimary transition-colors"
          >
            {link.label}
          </a>
        ))}
        {/* Training — active, no link */}
        <span className="text-xs font-semibold bg-primary/10 text-primary px-2 py-0.5 rounded">
          Training
        </span>
      </div>

      {/* Right: user email + sign out */}
      <div className="flex items-center gap-4">
        {user?.email && (
          <span className="text-xs text-textSecondary hidden sm:block">
            {user.email}
          </span>
        )}
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="text-xs text-danger hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

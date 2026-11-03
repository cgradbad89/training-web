/**
 * HubBanner — thin top bar linking to sibling hub apps.
 * Shows active state for Training and provides sign-out.
 */
"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks";
import { signOut } from "@/lib/auth";
import { isAuthorizedTrainingUser } from "@/lib/trainingAuthorization";

const HUB_NAV_LINKS = [
  { label: "Hub", href: process.env.NEXT_PUBLIC_HUB_URL ?? "#" },
  { label: "Budget", href: "https://budget-web-rose.vercel.app/" },
  { label: "Oracle", href: "https://oracle-web-pied.vercel.app/" },
  { label: "DC Catz", href: "https://dc-catz.vercel.app/" },
  { label: "Recipes", href: "https://mea-recipes.vercel.app/recipes" },
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
    <div className="bg-card border-b border-border h-10 flex items-center justify-between gap-3 px-3 sm:px-6 shrink-0">
      {/* Left: nav links (Hub links only visible to owner) */}
      <div className="flex min-w-0 items-center gap-3 sm:gap-6 overflow-x-auto whitespace-nowrap">
        {isAuthorizedTrainingUser(user?.email, user?.emailVerified) &&
          HUB_NAV_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="shrink-0 text-xs font-medium text-textSecondary hover:text-textPrimary transition-colors"
            >
              {link.label}
            </a>
          ))}
        {/* Training — active, no link */}
        <span className="shrink-0 text-xs font-semibold bg-primary/10 text-primary px-2 py-0.5 rounded">
          Training
        </span>
      </div>

      {/* Right: user email + sign out */}
      <div className="flex shrink-0 items-center gap-4">
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

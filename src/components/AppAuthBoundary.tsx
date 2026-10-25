"use client";

import { lazy, Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isRacePerformanceEnabled } from "@/lib/racePerformanceGate";

// Do not import AuthContext eagerly: it initializes Firebase and its persistent
// Firestore cache. The synthetic preview must never start that runtime.
const ApplicationAuthProvider = lazy(async () => {
  const { AuthProvider } = await import("@/contexts/AuthContext");
  return { default: AuthProvider };
});

export function AppAuthBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/race-confirmation-preview" && isRacePerformanceEnabled()) {
    return children;
  }

  return <Suspense fallback={<div role="status" className="p-6 text-sm text-textSecondary">Loading…</div>}>
    <ApplicationAuthProvider>{children}</ApplicationAuthProvider>
  </Suspense>;
}

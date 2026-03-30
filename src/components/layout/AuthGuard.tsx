"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/hooks";
import { FullPageLoader } from "@/components/ui/LoadingSpinner";

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * Wraps a page that requires authentication.
 * Redirects to /login if the user is not signed in.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  if (loading) return <FullPageLoader />;
  if (!user) return null;

  return <>{children}</>;
}

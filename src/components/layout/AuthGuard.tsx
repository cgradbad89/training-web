"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { type User } from "firebase/auth";
import { useAuth } from "@/hooks";
import { FullPageLoader } from "@/components/ui/LoadingSpinner";
import { useClientPerformanceMark } from "@/hooks/useClientPerformanceMark";

interface AuthGuardProps {
  children:
    | React.ReactNode
    | ((auth: { user: User; loading: false }) => React.ReactNode);
}

/**
 * Wraps a page that requires authentication.
 * Redirects to /login if the user is not signed in.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { user, loading, authorizationStatus } = useAuth();
  const router = useRouter();
  const authorized = authorizationStatus === "authorized" && Boolean(user);
  useClientPerformanceMark("training:auth-ready", !loading && authorized);

  useEffect(() => {
    if (!loading && !authorized) {
      router.replace("/login");
    }
  }, [authorized, loading, router]);

  if (loading) return <FullPageLoader />;
  if (!authorized || !user) return null;

  return (
    <>
      {typeof children === "function"
        ? children({ user, loading: false })
        : children}
    </>
  );
}

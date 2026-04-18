"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Activity } from "lucide-react";
import { useAuth } from "@/hooks";
import { signInWithGoogle } from "@/lib/auth";

export default function LoginPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.replace("/dashboard");
    }
  }, [user, loading, router]);

  async function handleSignIn() {
    setSigningIn(true);
    try {
      await signInWithGoogle();
      router.push("/dashboard");
    } catch (err) {
      console.error("Sign-in failed:", err);
      setSigningIn(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface" />
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface">
      <div className="bg-card rounded-2xl shadow-sm border border-border p-10 max-w-sm w-full mx-auto flex flex-col items-center">
        {/* Icon */}
        <Activity size={48} className="text-primary" />

        {/* App name */}
        <h1 className="text-2xl font-bold text-textPrimary mt-4 text-center">
          Training
        </h1>

        {/* Tagline */}
        <p className="text-sm text-textSecondary mt-2 text-center">
          Your runs, plans, and races — all in one place
        </p>

        {/* Google sign-in button */}
        <button
          onClick={handleSignIn}
          disabled={signingIn}
          className="mt-8 w-full bg-card border border-border shadow-sm rounded-xl py-3 flex items-center justify-center gap-3 text-sm font-medium text-textPrimary hover:bg-surface transition-colors disabled:opacity-60"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            <path fill="none" d="M0 0h48v48H0z"/>
          </svg>
          {signingIn ? "Signing in…" : "Continue with Google"}
        </button>

        {/* Bottom note */}
        <p className="mt-6 text-xs text-textSecondary text-center">
          Connected to Strava · Synced via Firebase
        </p>
      </div>
    </div>
  );
}

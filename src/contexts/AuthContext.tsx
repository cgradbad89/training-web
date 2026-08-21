"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type User } from "firebase/auth";
import { onAuthChange } from "@/lib/auth";

export interface AuthState {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Owns the application's single Firebase auth observer. Keeping it above the
 * route tree lets every useAuth consumer share one resolved auth state across
 * page navigation instead of registering another onAuthStateChanged listener.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthChange((nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
  }, []);

  const value = useMemo(() => ({ user, loading }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthState {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}

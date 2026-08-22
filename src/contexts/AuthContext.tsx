"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type User } from "firebase/auth";
import { onAuthChange, signOut } from "@/lib/auth";
import {
  isAuthorizedTrainingUser,
  UNAUTHORIZED_TRAINING_USER_MESSAGE,
} from "@/lib/trainingAuthorization";

export type ApplicationAuthStatus =
  | "loading"
  | "authorized"
  | "unauthorized"
  | "signed-out";

export interface AuthState {
  /** Present only for the verified, authorized Training Web owner. */
  user: User | null;
  loading: boolean;
  authorizationStatus: ApplicationAuthStatus;
  authorizationError: string | null;
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
  const [authorizationStatus, setAuthorizationStatus] =
    useState<ApplicationAuthStatus>("loading");
  const [authorizationError, setAuthorizationError] = useState<string | null>(
    null
  );
  const rejectingUnauthorizedRef = React.useRef(false);

  useEffect(() => {
    return onAuthChange((nextUser) => {
      if (!nextUser) {
        setUser(null);
        setLoading(false);
        if (rejectingUnauthorizedRef.current) {
          rejectingUnauthorizedRef.current = false;
          return;
        }
        setAuthorizationStatus("signed-out");
        setAuthorizationError(null);
        return;
      }

      if (
        !isAuthorizedTrainingUser(nextUser.email, nextUser.emailVerified)
      ) {
        rejectingUnauthorizedRef.current = true;
        setUser(null);
        setLoading(false);
        setAuthorizationStatus("unauthorized");
        setAuthorizationError(UNAUTHORIZED_TRAINING_USER_MESSAGE);
        void signOut().catch((error) => {
          console.error("Unauthorized account sign-out failed:", error);
        });
        return;
      }

      rejectingUnauthorizedRef.current = false;
      setUser(nextUser);
      setLoading(false);
      setAuthorizationStatus("authorized");
      setAuthorizationError(null);
    });
  }, []);

  const value = useMemo(
    () => ({ user, loading, authorizationStatus, authorizationError }),
    [user, loading, authorizationStatus, authorizationError]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthState {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}

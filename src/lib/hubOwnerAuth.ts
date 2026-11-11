/**
 * Owner authentication for the Hub summary endpoint.
 *
 * The hub forwards the signed-in user's Firebase ID token as
 * `Authorization: Bearer <token>`. This verifies it with the Admin SDK and then
 * applies the SAME single-owner rule the rest of Training Web uses
 * (`isAuthorizedTrainingUser`: verified email === owner). It returns the
 * verified uid for the caller to scope reads to — never the token or email.
 *
 * `@/lib/firebaseAdmin` is imported lazily: it JSON-parses
 * FIREBASE_SERVICE_ACCOUNT_JSON at import time and throws if that is missing or
 * malformed, which must become a generic 500, not a crashed route module.
 */

import { isAuthorizedTrainingUser } from "@/lib/trainingAuthorization";

export type HubOwnerAuthResult =
  | { ok: true; uid: string }
  | { ok: false; status: 401 | 403 | 500; error: string };

/** Case-insensitive `Bearer` scheme, surrounding whitespace trimmed, exactly one token. */
export function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export async function verifyHubOwner(request: Request): Promise<HubOwnerAuthResult> {
  const token = parseBearerToken(request.headers.get("Authorization"));
  if (!token) return { ok: false, status: 401, error: "Unauthorized" };

  let auth: { verifyIdToken: (token: string) => Promise<{ uid?: unknown; email?: string; email_verified?: boolean }> };
  try {
    const { getAuth } = await import("@/lib/firebaseAdmin");
    auth = getAuth();
  } catch {
    return { ok: false, status: 500, error: "Server error" };
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch {
    return { ok: false, status: 401, error: "Invalid token" };
  }

  if (!isAuthorizedTrainingUser(decoded.email, decoded.email_verified)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const uid = decoded.uid;
  if (typeof uid !== "string" || uid.length === 0 || uid.includes("/")) {
    return { ok: false, status: 401, error: "Invalid token" };
  }
  return { ok: true, uid };
}

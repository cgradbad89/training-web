import type { Credential } from "./capture-storage";

const AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/\d{6,}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const STS_URL = "https://sts.googleapis.com/v1/token";
const REFRESH_MARGIN_MS = 60_000;

export interface ImpersonationConfig {
  /** Workload Identity Pool provider resource, `//iam.googleapis.com/projects/N/locations/global/workloadIdentityPools/P/providers/R`. */
  audience: string;
  serviceAccountEmail: string;
  /** The only project the identity may belong to. */
  projectId: string;
  scopes: readonly string[];
  /** Supplies the short-lived platform OIDC token (on Vercel, `VERCEL_OIDC_TOKEN`). Never logged. */
  oidcToken: () => Promise<string>;
  request: typeof fetch;
  now?: () => number;
}

/**
 * Keyless short-lived credential: platform OIDC token → Workload Identity Federation STS exchange →
 * service-account impersonation. No downloadable service-account key exists in this path. Errors are
 * deliberately generic so no token, header or response body can reach a log.
 */
export function createImpersonatedCredential(config: ImpersonationConfig): Credential {
  const match = SERVICE_ACCOUNT.exec(config.serviceAccountEmail);
  if (!AUDIENCE.test(config.audience) || !match || match[1] !== config.projectId || config.scopes.length === 0) {
    throw new TypeError("Capture credential requires a workload identity audience and a same-project service account");
  }
  const now = config.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;

  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const response = await config.request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Capture credential exchange failed");
    return (await response.json()) as Record<string, unknown>;
  };

  return {
    principal: config.serviceAccountEmail,
    async accessToken() {
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token;
      const subject = await config.oidcToken();
      if (typeof subject !== "string" || !subject) throw new Error("Capture credential exchange failed");
      const federated = await post(STS_URL, {}, {
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange", audience: config.audience,
        scope: "https://www.googleapis.com/auth/cloud-platform", requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt", subjectToken: subject,
      });
      if (typeof federated.access_token !== "string") throw new Error("Capture credential exchange failed");
      const issued = await post(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:generateAccessToken`,
        { Authorization: `Bearer ${federated.access_token}` }, { scope: [...config.scopes], lifetime: "900s" });
      const expiresAt = typeof issued.expireTime === "string" ? Date.parse(issued.expireTime) : NaN;
      if (typeof issued.accessToken !== "string" || !Number.isFinite(expiresAt)) throw new Error("Capture credential exchange failed");
      cached = { token: issued.accessToken, expiresAt };
      return cached.token;
    },
  };
}

export const CAPTURE_SCOPES = {
  /** Object create-only writer and generation verifier. */
  storage: ["https://www.googleapis.com/auth/devstorage.read_write"],
  storageReadOnly: ["https://www.googleapis.com/auth/devstorage.read_only"],
  firestoreReader: ["https://www.googleapis.com/auth/datastore"],
} as const;

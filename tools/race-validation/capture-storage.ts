import { createHash } from "node:crypto";
import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";
import { instant, list, record, string } from "./evidence";
import type { CaptureStore } from "./scheduled-capture";

const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface Credential {
  principal: string;
  accessToken(): Promise<string>;
}

/**
 * `locked` (default) requires an irreversibly locked bucket retention policy.
 * `unlocked_pilot` accepts a present but still-removable policy. Server-assigned creation times and
 * create-only writes still prevent backdating, but the owner could remove the policy and delete
 * artifacts. The weaker guarantee is surfaced as `retentionLocked: false` on every receipt.
 */
export type RetentionMode = "locked" | "unlocked_pilot";

/** Least-privilege matrix verified at run time with Cloud Storage `testIamPermissions`. */
export const WRITER_PERMISSIONS = { required: ["storage.objects.create"],
  forbidden: ["storage.objects.get", "storage.objects.update", "storage.objects.delete", "storage.buckets.update", "storage.buckets.setIamPolicy", "storage.buckets.delete"] } as const;
export const VERIFIER_PERMISSIONS = { required: ["storage.objects.get", "storage.buckets.get"],
  forbidden: ["storage.objects.create", "storage.objects.update", "storage.objects.delete", "storage.buckets.update", "storage.buckets.setIamPolicy", "storage.buckets.delete"] } as const;

/** Dormant JSON API adapter. Callers must independently verify the actual IAM grants. */
export function createPrivateCaptureStore(config: {
  bucket: string;
  minimumRetentionSeconds: number;
  retentionMode?: RetentionMode;
  /** Omit for a verifier-only store (post-race retrieval and audit). */
  writer?: Credential;
  verifier: Credential;
  request: typeof fetch;
}): CaptureStore {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)
    || !Number.isSafeInteger(config.minimumRetentionSeconds) || config.minimumRetentionSeconds <= 0
    || !config.verifier.principal || (config.writer && (!config.writer.principal || config.writer.principal === config.verifier.principal))) {
    throw new TypeError("Capture requires a private bucket, minimum retention and distinct principals");
  }
  const bucket = encodeURIComponent(config.bucket);
  const metadataUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}`;
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`;
  const objectUrl = (name: string) => {
    if (!/^half-marathon\/v1\/[a-f0-9]{64}\.json$/.test(name)) throw new TypeError("Unexpected capture object key");
    return `${metadataUrl}/o/${encodeURIComponent(name)}`;
  };
  const request = async (credential: Credential, url: string | URL, body?: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await credential.accessToken()}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return config.request(url, { headers, method: body === undefined ? "GET" : "POST", body, redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(20_000) });
  };

  return {
    async verifyPolicy() {
      const mode = config.retentionMode ?? "locked";
      const response = await request(config.verifier, metadataUrl);
      if (!response.ok) throw new Error("Bucket policy unavailable");
      const metadata = record(await response.json(), "bucket policy");
      const iam = record(metadata.iamConfiguration, "bucket access");
      const uniform = record(iam.uniformBucketLevelAccess, "uniform access");
      const retention = record(metadata.retentionPolicy, "bucket retention");
      if (metadata.name !== config.bucket || iam.publicAccessPrevention !== "enforced" || uniform.enabled !== true
        || (mode === "locked" && retention.isLocked !== true)
        || !(Number(retention.retentionPeriod) >= config.minimumRetentionSeconds)) {
        throw new Error("Required private retained bucket policy is absent");
      }
      // The writer may only create and the verifier may only read. Over-privileged identities fail closed.
      for (const [credential, matrix] of [[config.writer, WRITER_PERMISSIONS], [config.verifier, VERIFIER_PERMISSIONS]] as const) {
        if (!credential) continue;
        const url = new URL(`${metadataUrl}/iam/testPermissions`);
        for (const permission of [...matrix.required, ...matrix.forbidden]) url.searchParams.append("permissions", permission);
        const response = await request(credential, url);
        if (!response.ok) throw new Error("Identity permissions unavailable");
        const held = new Set(list((record(await response.json(), "permissions")).permissions ?? [], "permissions"));
        if (!matrix.required.every(permission => held.has(permission)) || matrix.forbidden.some(permission => held.has(permission))) {
          throw new Error("Capture identity permissions are not least-privilege");
        }
      }
      return { retentionLocked: retention.isLocked === true };
    },
    async read(name) {
      const url = objectUrl(name);
      const metadataResponse = await request(config.verifier, url);
      if (metadataResponse.status === 404) return null;
      if (!metadataResponse.ok) throw new Error("Object metadata unavailable");
      const metadata = record(await metadataResponse.json(), "generation metadata");
      const generation = string(metadata.generation, "generation");
      const createdAt = instant(metadata.timeCreated, "generation creation timestamp");
      const retainUntil = instant(metadata.retentionExpirationTime, "generation retention expiration");
      const size = Number(metadata.size);
      const md5Hash = string(metadata.md5Hash, "generation md5Hash");
      if (metadata.bucket !== config.bucket || metadata.name !== name || !/^[1-9]\d*$/.test(generation)
        || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES
        || Date.parse(retainUntil) - Date.parse(createdAt) < config.minimumRetentionSeconds * 1000) {
        throw new Error("Object metadata does not establish retained generation");
      }
      const media = new URL(url);
      media.searchParams.set("alt", "media");
      media.searchParams.set("generation", generation);
      const response = await request(config.verifier, media);
      if (!response.ok) throw new Error("Pinned generation unavailable");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== size) throw new Error("Pinned generation size mismatch");
      // Storage computed this digest itself; matching the downloaded bytes ties them to the receipt.
      if (createHash("md5").update(new Uint8Array(bytes)).digest("base64") !== md5Hash) throw new Error("Pinned generation hash mismatch");
      return { generation, createdAt, artifact: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
    },
    async create(name, checkpoint) {
      objectUrl(name);
      if (!config.writer) throw new Error("This store has no writer identity");
      const body = canonicalizePerformanceValue(checkpoint);
      if (Buffer.byteLength(body) > MAX_ARTIFACT_BYTES) throw new Error("Capture exceeds private object budget");
      const url = new URL(uploadUrl);
      url.searchParams.set("name", name);
      url.searchParams.set("uploadType", "media");
      url.searchParams.set("ifGenerationMatch", "0");
      const response = await request(config.writer, url, body);
      if (response.status === 412) return "exists";
      if (!response.ok) throw new Error("Create-only object upload failed");
      return "created";
    },
  };
}

import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";
import { instant, record, string } from "./evidence";
import type { CaptureStore } from "./scheduled-capture";

const MAX_ARTIFACT_BYTES = 1024 * 1024;

interface Credential {
  principal: string;
  accessToken(): Promise<string>;
}

/** Dormant JSON API adapter. Callers must independently verify the actual IAM grants. */
export function createPrivateCaptureStore(config: {
  bucket: string;
  minimumRetentionSeconds: number;
  writer: Credential;
  verifier: Credential;
  request: typeof fetch;
}): CaptureStore {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)
    || !Number.isSafeInteger(config.minimumRetentionSeconds) || config.minimumRetentionSeconds <= 0
    || !config.writer.principal || !config.verifier.principal || config.writer.principal === config.verifier.principal) {
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
      const response = await request(config.verifier, metadataUrl);
      if (!response.ok) throw new Error("Bucket policy unavailable");
      const metadata = record(await response.json(), "bucket policy");
      const iam = record(metadata.iamConfiguration, "bucket access");
      const uniform = record(iam.uniformBucketLevelAccess, "uniform access");
      const retention = record(metadata.retentionPolicy, "bucket retention");
      if (metadata.name !== config.bucket || iam.publicAccessPrevention !== "enforced" || uniform.enabled !== true
        || retention.isLocked !== true || !(Number(retention.retentionPeriod) >= config.minimumRetentionSeconds)) {
        throw new Error("Required private locked bucket policy is absent");
      }
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
      return { generation, createdAt, artifact: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
    },
    async create(name, checkpoint) {
      objectUrl(name);
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

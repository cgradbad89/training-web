import { createHash } from "node:crypto";

/**
 * Stateful in-memory stand-in for the Cloud Storage JSON API, Security Token Service and IAM Credentials.
 * It models create-only preconditions, server-assigned generations and times, hashes, permission matrices
 * and retention metadata. It cannot prove real IAM, bucket-lock enforcement or billing; those need a
 * dry run in an approved environment.
 */
export interface FakeGcsOptions {
  bucket: string;
  clock: () => string;
  retentionSeconds?: number;
  locked?: boolean;
  publicAccessPrevention?: string;
  /** Status returned when a create-only write meets an existing object. Real services may report 412 or 403. */
  conflictStatus?: 412 | 403;
  permissions?: Record<string, string[]>;
  projectNumber?: string;
}

export const WRITER_HELD = ["storage.objects.create"];
export const VERIFIER_HELD = ["storage.objects.get", "storage.buckets.get"];

export function createFakeGcs(options: FakeGcsOptions) {
  const objects = new Map<string, { generation: number; timeCreated: string; body: Uint8Array; md5: string; size: number }>();
  const calls: { method: string; url: string; principal: string | null }[] = [];
  let generations = 100;
  let tokens = 0;
  const state = { ...options, failNextUpload: 0, failNextRead: 0 };
  const held = (principal: string) => state.permissions?.[principal] ?? (principal.startsWith("writer") ? WRITER_HELD : VERIFIER_HELD);
  const principalOf = (headers: unknown) => {
    const auth = (headers as Record<string, string> | undefined)?.Authorization ?? "";
    const token = auth.replace("Bearer ", "");
    return token.startsWith("token:") ? token.slice(6) : token;
  };
  const md5 = (body: Uint8Array) => createHash("md5").update(body).digest("base64");
  const metadataOf = (name: string) => {
    const object = objects.get(name)!;
    const created = Date.parse(object.timeCreated);
    return { bucket: state.bucket, name, generation: String(object.generation), timeCreated: object.timeCreated, size: String(object.size),
      md5Hash: object.md5,
      ...(state.retentionSeconds ? { retentionExpirationTime: new Date(created + state.retentionSeconds * 1000).toISOString() } : {}) };
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const principal = principalOf(init?.headers);
    calls.push({ method, url: url.toString(), principal: principal || null });
    if (url.host === "sts.googleapis.com") return Response.json({ access_token: `sts-${++tokens}` });
    if (url.host === "iamcredentials.googleapis.com") {
      const email = decodeURIComponent(/serviceAccounts\/([^:]+):generateAccessToken/.exec(url.pathname)![1]);
      return Response.json({ accessToken: `token:${email}`, expireTime: new Date(Date.parse(state.clock()) + 900_000).toISOString() });
    }
    const base = `/storage/v1/b/${state.bucket}`;
    if (url.pathname === base) {
      return Response.json({ name: state.bucket, iamConfiguration: { publicAccessPrevention: state.publicAccessPrevention ?? "enforced", uniformBucketLevelAccess: { enabled: true } },
        ...(state.retentionSeconds ? { retentionPolicy: { retentionPeriod: String(state.retentionSeconds), isLocked: state.locked === true } } : {}) });
    }
    if (url.pathname === `${base}/iam/testPermissions`) {
      const own = new Set(held(principal));
      return Response.json({ permissions: url.searchParams.getAll("permissions").filter(permission => own.has(permission)) });
    }
    if (url.pathname === `/upload${base}/o`) {
      if (!held(principal).includes("storage.objects.create")) return new Response(null, { status: 403 });
      if (state.failNextUpload > 0) { state.failNextUpload--; return new Response(null, { status: 503 }); }
      const name = url.searchParams.get("name")!;
      if (url.searchParams.get("ifGenerationMatch") === "0" && objects.has(name)) return new Response(null, { status: state.conflictStatus ?? 412 });
      if (objects.has(name)) return new Response(null, { status: 403 });
      const body = new TextEncoder().encode(String(init?.body));
      objects.set(name, { generation: ++generations, timeCreated: state.clock(), body, md5: md5(body), size: body.byteLength });
      return Response.json({ name });
    }
    const match = new RegExp(`^${base}/o/(.+)$`).exec(url.pathname);
    if (match && method === "GET") {
      if (!held(principal).includes("storage.objects.get")) return new Response(null, { status: 403 });
      if (state.failNextRead > 0) { state.failNextRead--; return new Response(null, { status: 503 }); }
      const name = decodeURIComponent(match[1]);
      const object = objects.get(name);
      if (!object) return new Response(null, { status: 404 });
      if (url.searchParams.get("alt") === "media") {
        return url.searchParams.get("generation") === String(object.generation) ? new Response(Buffer.from(object.body)) : new Response(null, { status: 404 });
      }
      return Response.json(metadataOf(name));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return {
    fetch: fetchImpl, objects, calls, state,
    /** Replaces stored bytes while leaving the storage-computed size and hash, as a corrupted or swapped object would. */
    tamper(name: string, text: string) { objects.get(name)!.body = new TextEncoder().encode(text); },
    remove(name: string) { objects.delete(name); },
  };
}

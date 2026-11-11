import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRAINING_WEB_OWNER_EMAIL } from "@/lib/trainingAuthorization";

const verifyIdToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/firebaseAdmin", () => ({
  getAuth: () => ({ verifyIdToken }),
}));

import { parseBearerToken, verifyHubOwner } from "@/lib/hubOwnerAuth";

function req(authorization?: string): Request {
  return new Request("https://example.test/api/hub/summary", {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

beforeEach(() => {
  verifyIdToken.mockReset();
});

describe("parseBearerToken", () => {
  it("accepts the Bearer scheme case-insensitively and trims whitespace", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer abc")).toBe("abc");
    expect(parseBearerToken("BEARER   abc  ")).toBe("abc");
  });

  it.each([null, "", "Bearer", "Bearer ", "Basic abc", "Bearer a b", "abc", "Token abc"])(
    "rejects %j",
    (value) => {
      expect(parseBearerToken(value)).toBeNull();
    }
  );
});

describe("verifyHubOwner", () => {
  it("401s a missing or malformed header without calling Firebase", async () => {
    for (const header of [undefined, "", "Bearer", "Basic abc", "Bearer a b"]) {
      expect(await verifyHubOwner(req(header))).toEqual({ ok: false, status: 401, error: "Unauthorized" });
    }
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("401s a token Firebase rejects", async () => {
    verifyIdToken.mockRejectedValue(new Error("auth/argument-error secret-detail"));
    const result = await verifyHubOwner(req("Bearer bad"));
    expect(result).toEqual({ ok: false, status: 401, error: "Invalid token" });
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });

  it("403s a valid token for someone other than the owner", async () => {
    verifyIdToken.mockResolvedValue({ uid: "u1", email: "someone@else.test", email_verified: true });
    expect(await verifyHubOwner(req("Bearer t"))).toEqual({ ok: false, status: 403, error: "Forbidden" });
  });

  it("403s the owner's email when it is not verified", async () => {
    verifyIdToken.mockResolvedValue({ uid: "u1", email: TRAINING_WEB_OWNER_EMAIL, email_verified: false });
    expect(await verifyHubOwner(req("Bearer t"))).toMatchObject({ ok: false, status: 403 });
  });

  it("returns only the verified uid for the owner (email matched case-insensitively)", async () => {
    verifyIdToken.mockResolvedValue({
      uid: "owner-uid",
      email: ` ${TRAINING_WEB_OWNER_EMAIL.toUpperCase()} `,
      email_verified: true,
    });
    const result = await verifyHubOwner(req("bearer   tok  "));
    expect(result).toEqual({ ok: true, uid: "owner-uid" });
    expect(verifyIdToken).toHaveBeenCalledWith("tok");
  });

  it("rejects an owner token with no usable uid", async () => {
    verifyIdToken.mockResolvedValue({ uid: "a/b", email: TRAINING_WEB_OWNER_EMAIL, email_verified: true });
    expect(await verifyHubOwner(req("Bearer t"))).toMatchObject({ ok: false, status: 401 });
  });
});

describe("verifyHubOwner when firebaseAdmin cannot load", () => {
  it("returns a generic 500 instead of throwing", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebaseAdmin", () => {
      throw new SyntaxError("Unexpected token in FIREBASE_SERVICE_ACCOUNT_JSON");
    });
    const { verifyHubOwner: verifyWithBrokenAdmin } = await import("@/lib/hubOwnerAuth");
    const result = await verifyWithBrokenAdmin(req("Bearer t"));
    expect(result).toEqual({ ok: false, status: 500, error: "Server error" });
    vi.doUnmock("@/lib/firebaseAdmin");
  });
});

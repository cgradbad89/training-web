import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHubWorkout } from "@/lib/hubTrainingWeek";
import { zonedWeekFor } from "@/lib/hubWeek";
import type { HubSummary, TrainingData } from "@/lib/hub-contract";

const h = vi.hoisted(() => ({
  verifyHubOwner: vi.fn(),
  readHubWeek: vi.fn(),
}));

vi.mock("@/lib/hubOwnerAuth", () => ({ verifyHubOwner: h.verifyHubOwner }));
vi.mock("@/lib/hubAdminReader", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/hubAdminReader")>();
  return { ...original, readHubWeek: h.readHubWeek };
});

import { HubReadError } from "@/lib/hubAdminReader";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "../route";

const NOW = new Date("2026-11-11T17:00:00.000Z");
const SECRET_TOKEN = "tok-SECRET-9f2c";
const SECRET_UID = "uid-SECRET-77aa";
const SECRET_EMAIL = "private.person@example.test";

function request(method = "GET"): Request {
  return new Request("https://example.test/api/hub/summary", {
    method,
    headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
  });
}

function okRead() {
  return {
    workouts: [
      toHubWorkout("w1", {
        workoutId: "w1", startDate: new Date("2026-11-10T15:00:00.000Z"),
        endDate: new Date("2026-11-10T15:40:00.000Z"), durationSeconds: 2400,
        isRunLike: true, distanceMiles: 4.25, displayType: "Run", activityType: "running",
      }),
      toHubWorkout("w2", {
        workoutId: "w2", startDate: new Date("2026-11-12T11:00:00.000Z"),
        endDate: new Date("2026-11-12T11:45:00.000Z"), durationSeconds: 2700,
        isRunLike: false, displayType: "Pilates", activityType: "pilates",
      }),
    ],
    overrides: {},
    plans: [],
    stagesMs: { workouts: 12, overrides: 3, plans: 7 },
    counts: { workouts: 2, overrides: 0, plans: 0 },
  };
}

/** Structural check against the hub's TrainingData contract. */
function expectTrainingEnvelope(body: HubSummary<TrainingData>) {
  expect(body.status).toBe("ok");
  if (body.status !== "ok") return;
  expect(body.app).toBe("training");
  expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
  expect(body.periodLabel).toBe("Nov 9–15");
  expect(body.appUrl).toBe("https://training-web-rho.vercel.app/dashboard");
  expect(body.data.days).toHaveLength(7);
  body.data.days.forEach((day, i) => {
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (i > 0) expect(day.date > body.data.days[i - 1].date).toBe(true);
    expect(Array.isArray(day.completed)).toBe(true);
    if (day.planned !== undefined) expect(typeof day.planned).toBe("string");
    for (const item of day.completed) {
      expect(typeof item.type).toBe("string");
      if (item.miles !== undefined) expect(typeof item.miles).toBe("number");
    }
  });
  for (const group of [body.data.totals, body.data.planned]) {
    expect(Object.keys(group).sort()).toEqual(["miles", "runs", "workouts"]);
    for (const value of Object.values(group)) expect(typeof value).toBe("number");
  }
}

function expectCommonHeaders(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("Vary")).toBe("Authorization");
  expect(res.headers.get("Set-Cookie")).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
}

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.verifyHubOwner.mockReset().mockResolvedValue({ ok: true, uid: SECRET_UID });
  h.readHubWeek.mockReset().mockResolvedValue(okRead());
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/hub/summary", () => {
  it("returns the ok envelope for the owner with the contract shape and Eastern week", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expectCommonHeaders(res);
    const body = (await res.json()) as HubSummary<TrainingData>;
    expectTrainingEnvelope(body);
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.data.totals).toEqual({ runs: 1, miles: 4.25, workouts: 1 });
    expect(body.data.days.map((d) => d.date)[0]).toBe("2026-11-09");
    // The reader is scoped to the verified uid and the exact Eastern week.
    const week = zonedWeekFor(NOW);
    expect(h.readHubWeek).toHaveBeenCalledTimes(1);
    expect(h.readHubWeek.mock.calls[0][0]).toBe(SECRET_UID);
    expect(h.readHubWeek.mock.calls[0][1]).toMatchObject({
      startInstant: week.startInstant,
      endExclusiveInstant: week.endExclusiveInstant,
    });
  });

  it("401s without reading any data when auth fails, and 403s a non-owner", async () => {
    h.verifyHubOwner.mockResolvedValueOnce({ ok: false, status: 401, error: "Unauthorized" });
    let res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expectCommonHeaders(res);

    h.verifyHubOwner.mockResolvedValueOnce({ ok: false, status: 401, error: "Invalid token" });
    res = await GET(request());
    expect(res.status).toBe(401);
    expectCommonHeaders(res);

    h.verifyHubOwner.mockResolvedValueOnce({ ok: false, status: 403, error: "Forbidden" });
    res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expectCommonHeaders(res);

    expect(h.readHubWeek).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when auth configuration fails", async () => {
    h.verifyHubOwner.mockResolvedValueOnce({ ok: false, status: 500, error: "Server error" });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Server error" });
    expectCommonHeaders(res);
  });

  it.each(["permission", "upstream"] as const)(
    "returns the unavailable envelope (200) with reason '%s' on an adapter failure",
    async (reason) => {
      h.readHubWeek.mockRejectedValueOnce(new HubReadError(reason));
      const res = await GET(request());
      expect(res.status).toBe(200);
      expectCommonHeaders(res);
      expect(await res.json()).toEqual({
        status: "unavailable",
        app: "training",
        generatedAt: NOW.toISOString(),
        reason,
      });
    }
  );

  it("returns unavailable/'timeout' once the 10 s deadline passes", async () => {
    h.readHubWeek.mockReturnValueOnce(new Promise(() => undefined));
    const pending = GET(request());
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(200);
    expectCommonHeaders(res);
    expect(await res.json()).toMatchObject({ status: "unavailable", app: "training", reason: "timeout" });
  });

  it("returns a generic 500 for an unexpected failure and never exposes its message", async () => {
    h.readHubWeek.mockRejectedValueOnce(new Error(`boom ${SECRET_UID} ${SECRET_EMAIL}`));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expectCommonHeaders(res);
    expect(await res.json()).toEqual({ error: "Server error" });
  });
});

describe("non-GET methods", () => {
  it.each([
    ["POST", POST], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE], ["HEAD", HEAD], ["OPTIONS", OPTIONS],
  ] as const)("%s returns 405 with Allow: GET and never authenticates or reads", async (method, handler) => {
    const res = await handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expectCommonHeaders(res);
    expect(await res.json()).toEqual({ error: "Method not allowed" });
    expect(method).toBeTruthy();
    expect(h.verifyHubOwner).not.toHaveBeenCalled();
    expect(h.readHubWeek).not.toHaveBeenCalled();
  });
});

describe("logging and secrecy", () => {
  const LINE =
    /^\[hub-summary\] timing outcome=(ok|unavailable|timeout|error|denied) total_ms=\d+ stages=auth:\d+,workouts:\d+,overrides:\d+,plans:\d+,summary:\d+ counts=workouts:\d+,overrides:\d+,plans:\d+$/;

  async function run(setup: () => void) {
    setup();
    return GET(request());
  }

  it("emits exactly one fixed-format timing line per request, with the right outcome", async () => {
    const cases: [string, () => void][] = [
      ["ok", () => undefined],
      ["unavailable", () => h.readHubWeek.mockRejectedValueOnce(new HubReadError("upstream"))],
      ["error", () => h.readHubWeek.mockRejectedValueOnce(new Error("x"))],
      ["denied", () => h.verifyHubOwner.mockResolvedValueOnce({ ok: false, status: 403, error: "Forbidden" })],
    ];
    for (const [outcome, setup] of cases) {
      info.mockClear();
      await run(setup);
      const timingLines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[hub-summary] timing"));
      expect(timingLines).toHaveLength(1);
      expect(timingLines[0]).toMatch(LINE);
      expect(timingLines[0]).toContain(`outcome=${outcome}`);
    }
  });

  it("reports stage timings and counts from the read, as integers", async () => {
    await GET(request());
    const line = String(info.mock.calls.at(-1)?.[0]);
    expect(line).toContain("workouts:12,overrides:3,plans:7");
    expect(line).toContain("counts=workouts:2,overrides:0,plans:0");
  });

  it("never puts the token, uid or email in any response body or log line", async () => {
    const responses: Response[] = [];
    responses.push(await GET(request()));
    h.readHubWeek.mockRejectedValueOnce(new HubReadError("permission"));
    responses.push(await GET(request()));
    h.readHubWeek.mockRejectedValueOnce(new Error(`${SECRET_TOKEN} ${SECRET_UID} ${SECRET_EMAIL}`));
    responses.push(await GET(request()));
    h.verifyHubOwner.mockResolvedValueOnce({ ok: false, status: 403, error: "Forbidden" });
    responses.push(await GET(request()));
    responses.push(await POST());

    const bodies = await Promise.all(responses.map((r) => r.text()));
    const logs = [...info.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(" "));
    for (const text of [...bodies, ...logs]) {
      for (const secret of [SECRET_TOKEN, SECRET_UID, SECRET_EMAIL]) expect(text).not.toContain(secret);
    }
    for (const response of responses) {
      for (const [, value] of response.headers.entries()) {
        for (const secret of [SECRET_TOKEN, SECRET_UID, SECRET_EMAIL]) expect(value).not.toContain(secret);
      }
    }
  });
});

import { createHash } from "node:crypto";
import { canonicalizePerformanceValue, isPerformanceDate, isPerformanceInstant } from "@/utils/performanceEvidence";

export const PROTOCOL = "half-marathon-validation-v1";
export const HORIZONS = [28, 14, 7, 1] as const;
export type Horizon = typeof HORIZONS[number];

export type RecordValue = Record<string, unknown>;

export function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as RecordValue;
}

export function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

export function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value;
}

export function key(value: unknown, field: string): string {
  const id = string(value, field);
  if (id in Object.prototype) throw new TypeError(`${field} is reserved`);
  return id;
}

export function instant(value: unknown, field: string): string {
  if (typeof value !== "string" || !isPerformanceInstant(value) || Date.parse(value) <= 0) {
    throw new TypeError(`${field} must be a known UTC instant`);
  }
  return new Date(value).toISOString();
}

export function date(value: unknown, field: string): string {
  if (typeof value !== "string" || !isPerformanceDate(value)) throw new TypeError(`${field} must be a local date`);
  return value;
}

export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const selected = choices.find(option => option === value);
  if (selected === undefined) throw new TypeError(`${field} must be one of ${choices.join(", ")}`);
  return selected;
}

export function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be positive`);
  return value;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalizePerformanceValue(value)).digest("hex");
}

export function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return value;
}

export function requireVersion(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new TypeError(`${field} mismatch (expected ${expected})`);
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function fieldProjection(input: RecordValue, keys: readonly string[]): RecordValue {
  return Object.fromEntries(keys.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
}

export function readTarget(value: unknown) {
  const target = record(value, "target");
  const timeZone = string(target.timeZone, "target.timeZone");
  new Intl.DateTimeFormat("en-US", { timeZone });
  return {
    subject: key(target.subject, "target.subject"),
    raceId: key(target.raceId, "target.raceId"),
    raceDate: date(target.raceDate, "target.raceDate"),
    timeZone,
  };
}

export type Target = ReturnType<typeof readTarget>;

export function targetKey(target: Target): string {
  return JSON.stringify([target.subject, target.raceId, target.raceDate, target.timeZone]);
}

export function checkpointKey(target: Target, horizon: Horizon): string {
  return JSON.stringify([targetKey(target), horizon]);
}

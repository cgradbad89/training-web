/** Match the browser Firestore SDK's Timestamp.toDate conversion for Admin data. */
export function browserTimestampDate(value: unknown): unknown {
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const raw = value as Record<string, unknown>;
  const seconds = raw.seconds ?? raw._seconds;
  const nanos = raw.nanoseconds ?? raw._nanoseconds;
  if (typeof seconds === "number" && Number.isInteger(seconds) && typeof nanos === "number"
    && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9) {
    return new Date(seconds * 1000 + nanos / 1e6);
  }
  return value;
}

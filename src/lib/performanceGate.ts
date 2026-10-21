/** Build-time opt-in only, after the owner has installed and verified Console rules. */
export function isPerformanceUpdateEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE === "true";
}

export function assertPerformanceUpdateEnabled(): void {
  if (!isPerformanceUpdateEnabled()) {
    throw new Error("Performance updates are disabled until the owner enables the reviewed Firebase configuration.");
  }
}

export function getPerformanceUpdateGate(): { enabled: boolean; reason: string | null } {
  const enabled = isPerformanceUpdateEnabled();
  return { enabled, reason: enabled ? null : "Performance updates are disabled until the owner reviews and enables Firebase permissions." };
}

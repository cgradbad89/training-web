import type { SavedPerformanceCurrent } from "@/types/performancePersistence";
import type { PerformanceMetadataObservation } from "@/types/performanceFreshness";

export interface PerformanceSessionState {
  status: "not_loaded" | "loading" | "absent" | "available" | "error";
  current: SavedPerformanceCurrent | null;
  retrievedAt: string | null;
  origin: "server" | "session" | "unknown";
  error: string | null;
  publication: "idle" | "processing" | "published" | "unchanged" | "failed";
  publicationError: string | null;
  observation: PerformanceMetadataObservation | null;
}

/** One instance per keyed authorized provider. No singleton, persistence or timers.
 * The IO boundary supplies the existing authorized/parser-backed one-doc loader. */
export function createPerformanceSessionStore(input: {
  isCurrent: () => boolean;
  load: () => Promise<SavedPerformanceCurrent | null>;
  now: () => string;
}) {
  let active = true, version = 0;
  let inFlight: Promise<void> | null = null;
  let state: PerformanceSessionState = { status: "not_loaded", current: null, retrievedAt: null,
    origin: "unknown", error: null, publication: "idle", publicationError: null, observation: null };
  const listeners = new Set<() => void>();
  const current = () => active && input.isCurrent();
  function emit(patch: Partial<PerformanceSessionState>) {
    state = { ...state, ...patch }; listeners.forEach(listener => listener());
  }
  function load(retry = false): Promise<void> {
    if (!current()) return Promise.resolve();
    if (inFlight) return inFlight;
    // Failure is resident too: navigation never silently retries it.
    if (state.status !== "not_loaded" && !(retry && state.status === "error")) return Promise.resolve();
    const request = version;
    emit({ status: "loading", error: null });
    const promise = Promise.resolve().then(() => {
      if (!current() || version !== request) return undefined;
      return input.load();
    }).then(saved => {
      if (!current() || version !== request || saved === undefined) return;
      emit({ status: saved ? "available" : "absent", current: saved, retrievedAt: input.now(), origin: "server", error: null });
    }).catch(reason => {
      if (current() && version === request) emit({ status: "error", error: reason instanceof Error ? reason.message : "Saved performance could not be loaded." });
    }).finally(() => { if (inFlight === promise) inFlight = null; });
    inFlight = promise;
    return promise;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() { active = true; },
    deactivate() { active = false; },
    ensureLoaded: () => load(),
    retry: () => load(true),
    rememberObservation(observation: PerformanceMetadataObservation) {
      if (current() && state.current?.publicationDigest === observation.publicationDigest
        && state.observation?.publicationDigest !== observation.publicationDigest) emit({ observation });
    },
    beginPublication() { if (current()) emit({ publication: "processing", publicationError: null }); },
    receivePublication(saved: SavedPerformanceCurrent, snapshotCreated: boolean) {
      if (!current()) return;
      version += 1; // An older cold request must never overwrite a confirmed publication.
      const same = !snapshotCreated && state.current?.snapshotId === saved.snapshotId
        && state.current.revision === saved.revision && state.current.publicationDigest === saved.publicationDigest;
      emit({ current: same ? state.current : saved, status: "available", error: null,
        origin: "session", retrievedAt: input.now(), publication: snapshotCreated ? "published" : "unchanged", publicationError: null });
    },
    failPublication(message: string) {
      if (current()) emit({ publication: "failed", publicationError: message });
    },
  };
}

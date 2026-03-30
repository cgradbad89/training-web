"use client";

import { useState, useEffect } from "react";
import { type StravaActivity } from "@/types";
import { fetchActivities } from "@/services";

interface UseActivitiesOptions {
  limitCount?: number;
  type?: string;
}

interface UseActivitiesState {
  activities: StravaActivity[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useActivities(opts: UseActivitiesOptions = {}): UseActivitiesState {
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchActivities(opts)
      .then((data) => {
        if (!cancelled) setActivities(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.limitCount, opts.type, rev]);

  return { activities, loading, error, reload: () => setRev((r) => r + 1) };
}

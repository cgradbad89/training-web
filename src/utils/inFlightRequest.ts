export interface InFlightRequestRef<T> {
  current: Promise<T> | null;
}

/**
 * Stores a request as the current in-flight operation and clears it when the
 * same request settles. Returning the original promise preserves deduplication
 * identity for callers that arrive while the request is still running.
 */
export function trackInFlightRequest<T>(
  ref: InFlightRequestRef<T>,
  request: Promise<T>
): Promise<T> {
  ref.current = request;

  const clearRequest = () => {
    if (ref.current === request) ref.current = null;
  };
  void request.then(clearRequest, clearRequest);

  return request;
}

import { useEffect, useState } from "react";

/**
 * Tailwind's `md` breakpoint. Chosen as the width at which a chart can afford a
 * SECOND y-axis's tick labels without the labels eating the plot area (the same
 * pressure that made RunOverlayChart hide its left axis on mobile).
 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

/**
 * `true` while the viewport matches `query`.
 *
 * Starts `false` on the server AND on the client's first render, then syncs in
 * an effect — so the server and client agree on the first paint and hydration
 * can never mismatch. Consumers must therefore read `false` as "not yet known
 * to match", not "definitely does not match": fine for progressively revealing
 * chart furniture, wrong for anything load-bearing.
 *
 * Exists because Recharts renders axis ticks as raw SVG <text>, which Tailwind
 * responsive classes can't target per-element — the breakpoint has to be known
 * in JS to be passed to Recharts as a prop.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** `true` at >= 768px wide. See the caveat on useMediaQuery's initial value. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_MEDIA_QUERY);
}

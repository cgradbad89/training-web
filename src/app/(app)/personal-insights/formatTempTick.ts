/**
 * X-axis tick label for the weather scatter charts: whole degrees Fahrenheit.
 * The single source of the unit — the XAxis must NOT also set `unit`, because
 * Recharts appends `unit` after the tick formatter's output (which rendered
 * "58°°F").
 */
export function formatTempTick(tempF: number): string {
  return `${Math.round(tempF)}°F`;
}

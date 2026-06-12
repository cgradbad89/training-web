import { type WeatherSnapshot } from "@/types/weather";
import { wmoCodeToEmoji } from "@/lib/weather";

/**
 * Compact weather tile for the run detail header — the historical conditions
 * at the run's start point/time (from Open-Meteo). Values are rounded for
 * display here; the stored WeatherSnapshot keeps full precision.
 *
 * Colors/borders use the app's semantic tokens (bg-card / border-border /
 * text-textPrimary / text-textSecondary), which flip automatically in dark
 * mode via the prefers-color-scheme block in globals.css — no `dark:` prefix.
 */
export function WeatherTile({ weather }: { weather: WeatherSnapshot }) {
  return (
    <div className="bg-card border border-border rounded-xl px-3 py-2 min-w-[90px] text-center shrink-0">
      <div className="text-lg leading-none" aria-hidden>
        {wmoCodeToEmoji(weather.conditionCode)}
      </div>
      <div className="text-[15px] font-medium text-textPrimary mt-1 leading-tight">
        {Math.round(weather.tempF)}°
      </div>
      <div className="text-[11px] text-textSecondary leading-tight">
        {weather.conditionText}
      </div>

      <div className="border-t border-border my-2" />

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <WeatherCell label="Feels" value={`${Math.round(weather.feelsLikeF)}°`} />
        <WeatherCell label="Wind" value={`${Math.round(weather.windMph)} mph`} />
        <WeatherCell label="Humidity" value={`${Math.round(weather.humidity)}%`} />
        <WeatherCell label="Dew pt" value={`${Math.round(weather.dewPointF)}°`} />
      </div>

      <div className="text-[10px] text-textSecondary mt-2">Open-Meteo</div>
    </div>
  );
}

function WeatherCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] text-textSecondary">{label}</div>
      <div className="text-[12px] font-medium text-textPrimary">{value}</div>
    </div>
  );
}

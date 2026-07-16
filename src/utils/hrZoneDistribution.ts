import { classifyHrZone, type HRZoneNumber } from "@/utils/trainingLoad";

export interface MileSplitSample {
  mile: number;
  bpm: number;
  distance: number;
}

export interface HrZoneDistribution {
  zoneMiles: Record<HRZoneNumber, number>;
  totalMiles: number;
  runsCounted: number;
}

export function buildHrZoneDistribution(
  runsMileSplits: MileSplitSample[][],
  maxHr: number
): HrZoneDistribution {
  const zoneMiles: Record<HRZoneNumber, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };
  let totalMiles = 0;
  let runsCounted = 0;
  
  for (const miles of runsMileSplits) {
    if (miles.length === 0) continue;
    runsCounted += 1;
    for (const m of miles) {
      const z = classifyHrZone(m.bpm, maxHr);
      zoneMiles[z] += m.distance;
      totalMiles += m.distance;
    }
  }

  return { zoneMiles, totalMiles, runsCounted };
}

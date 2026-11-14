import { hrZoneIndex, type HrZoneAnchors, type HrZoneIndex } from "@/utils/zones";

export interface MileSplitSample {
  mile: number;
  bpm: number;
  distance: number;
}

export interface HrZoneDistribution {
  zoneMiles: Record<HrZoneIndex, number>;
  totalMiles: number;
  runsCounted: number;
}

export function buildHrZoneDistribution(
  runsMileSplits: MileSplitSample[][],
  anchors: HrZoneAnchors
): HrZoneDistribution {
  const zoneMiles: Record<HrZoneIndex, number> = {
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
      const z = hrZoneIndex(m.bpm, anchors);
      zoneMiles[z] += m.distance;
      totalMiles += m.distance;
    }
  }

  return { zoneMiles, totalMiles, runsCounted };
}

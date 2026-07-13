import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { fetchRoutePoints } from "@/services/routes";
import { computeMileSplits, type MileSplit } from "@/utils/mileSplits";
import { type HealthWorkout } from "@/types/healthWorkout";

export async function fetchSplitsForRuns(
  runs: HealthWorkout[],
  uid: string,
  onProgress?: (completed: number, total: number) => void
): Promise<Record<string, MileSplit[]>> {
  const result: Record<string, MileSplit[]> = {};
  
  // We only need to fetch splits for runs that have a route
  const runsWithRoute = runs.filter((r) => r.hasRoute);
  
  let completed = 0;
  if (onProgress) {
    onProgress(completed, runsWithRoute.length);
  }

  // Batch size to avoid hammering Firebase
  const BATCH_SIZE = 5;
  for (let i = 0; i < runsWithRoute.length; i += BATCH_SIZE) {
    const batch = runsWithRoute.slice(i, i + BATCH_SIZE);
    
    await Promise.all(
      batch.map(async (run) => {
        try {
          const workoutId = run.workoutId;
          const points = await fetchRoutePoints(uid, workoutId);
          
          if (points.length >= 2) {
            // Compute pace splits
            const computed = computeMileSplits(points, run.avgHeartRate, run.distanceMiles);
            
            // Fetch HR splits
            const hrSnap = await getDocs(
              query(
                collection(db, `users/${uid}/healthWorkouts/${workoutId}/mileSplits`),
                orderBy("mile", "asc")
              )
            );
            
            const hrMap: Record<number, number> = {};
            hrSnap.docs.forEach((doc) => {
              const data = doc.data();
              if (data.avgBpm && data.sampleCount >= 2) {
                hrMap[data.mile as number] = data.avgBpm as number;
              }
            });
            
            // Merge HR into computed splits
            result[workoutId] = computed.map((split) => ({
              ...split,
              avgBpm: hrMap[split.mile] ?? undefined,
            }));
          }
        } catch (error) {
          console.error(`Failed to fetch splits for run ${run.workoutId}`, error);
        } finally {
          completed++;
          if (onProgress) {
            onProgress(completed, runsWithRoute.length);
          }
        }
      })
    );
  }

  return result;
}

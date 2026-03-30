/**
 * Firestore collection path helpers.
 *
 * Per-user collections live under:
 *   users/{uid}/...
 *
 * Shared / synced collections (written by iPhone, read-only on web):
 *   stravaActivities/{activityId}   — raw Strava rows synced from iOS
 *
 * App-owned entities (editable on web and iPhone):
 *   users/{uid}/runningPlans/{planId}
 *   users/{uid}/halfMarathonRaces/{raceId}
 *   users/{uid}/runningShoes/{shoeId}
 *   users/{uid}/shoeAssignments/{activityId}
 *   users/{uid}/shoeAutoAssignmentRules/{ruleId}
 *   users/{uid}/settings/prefs   (single doc)
 */

export const COLLECTIONS = {
  stravaActivities: "stravaActivities",
  userDoc: (uid: string) => `users/${uid}`,
  runningPlans: (uid: string) => `users/${uid}/runningPlans`,
  halfMarathonRaces: (uid: string) => `users/${uid}/halfMarathonRaces`,
  runningShoes: (uid: string) => `users/${uid}/runningShoes`,
  shoeAssignments: (uid: string) => `users/${uid}/shoeAssignments`,
  shoeAutoAssignmentRules: (uid: string) => `users/${uid}/shoeAutoAssignmentRules`,
  userSettings: (uid: string) => `users/${uid}/settings`,
} as const;

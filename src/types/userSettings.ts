export interface UserSettings {
  uid: string;
  displayName?: string;
  email?: string;
  weightThresholdGreen: number;   // lbs, below this = green (default 173)
  weightThresholdYellow: number;  // lbs, above this = red   (default 180)
  defaultTargetPaceSecPerMile: number; // default 600 (10:00/mi)
  createdAt: string;
  updatedAt: string;
}

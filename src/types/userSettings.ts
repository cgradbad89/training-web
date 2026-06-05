import { type Timestamp } from "firebase/firestore";

export interface UserSettings {
  uid: string;
  displayName?: string;
  email?: string;
  weightThresholdGreen: number;   // lbs, below this = green (default 173)
  weightThresholdYellow: number;  // lbs, above this = red   (default 180)
  defaultTargetPaceSecPerMile: number; // default 600 (10:00/mi)
  maxHeartRate?: number; // user-set or accepted suggestion, bpm
  restingHeartRate?: number; // resting HR in bpm, for HR-reserve (Banister) load calc
  thresholdPaceSecPerMile?: number; // user-set threshold pace
  suggestedMaxHeartRate?: number; // last computed suggestion, bpm
  suggestedThresholdPaceSecPerMile?: number;
  suggestionsUpdatedAt?: Timestamp;
  createdAt: string;
  updatedAt: string;
}

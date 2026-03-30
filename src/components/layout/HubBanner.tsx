/**
 * HubBanner — thin top bar linking back to the main hub app.
 * Shown at the top of every authenticated page as context that this
 * is the Workouts section of a larger hub, matching the iOS multi-domain
 * navigation model.
 */
import React from "react";
import Link from "next/link";

export function HubBanner() {
  return (
    <div className="bg-gray-900 text-gray-300 text-xs py-1.5 px-4 flex items-center gap-2">
      <span className="text-gray-500">MY EVERYTHING APP</span>
      <span className="text-gray-600">/</span>
      <span className="text-white font-medium">Workouts</span>
    </div>
  );
}

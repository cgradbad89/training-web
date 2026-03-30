import React from "react";
import { PageHeader } from "@/components/layout/PageHeader";

export default function RacesPage() {
  return (
    <div>
      <PageHeader
        title="Races"
        subtitle="Half marathon races and goal pace"
      />
      <div className="text-gray-400 text-sm">Coming soon — race management, target pace, projected finish time.</div>
    </div>
  );
}

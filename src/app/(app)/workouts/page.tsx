import React from "react";
import { PageHeader } from "@/components/layout/PageHeader";

export default function WorkoutsPage() {
  return (
    <div>
      <PageHeader
        title="Workouts"
        subtitle="Non-running workout history and plans"
      />
      <div className="text-gray-400 text-sm">Coming soon — weight training workout log and A/B/C workout plans.</div>
    </div>
  );
}

import React from "react";
import { PageHeader } from "@/components/layout/PageHeader";

export default function DashboardPage() {
  return (
    <div>
      <PageHeader
        title="This Week"
        subtitle="Weekly training summary"
      />
      <div className="text-gray-400 text-sm">Coming soon — weekly stats, planned vs actual miles, and run list.</div>
    </div>
  );
}

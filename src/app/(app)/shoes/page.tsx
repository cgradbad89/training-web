import React from "react";
import { PageHeader } from "@/components/layout/PageHeader";

export default function ShoesPage() {
  return (
    <div>
      <PageHeader
        title="Shoes"
        subtitle="Running shoe mileage and management"
      />
      <div className="text-gray-400 text-sm">Coming soon — shoe CRUD, mileage tracking, and auto-assignment rules.</div>
    </div>
  );
}

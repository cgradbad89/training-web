"use client";

/**
 * Legacy running-plan edit route.
 *
 * Running plans are now edited IN-PLACE on the Plans page (RunningPlanDetail +
 * the shared PlanEditor), so this standalone route is no longer used. It is kept
 * as a thin redirect to /plans so any existing bookmarks or in-app links don't
 * 404. The route file/directory and the old inline editor are removed in a
 * follow-up cleanup once the in-place flow is proven.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PlanEditRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/plans");
  }, [router]);

  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

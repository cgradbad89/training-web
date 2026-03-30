import React from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
      {icon && <div className="text-4xl text-gray-300">{icon}</div>}
      <h3 className="text-lg font-semibold text-gray-700">{title}</h3>
      {description && <p className="text-sm text-gray-500 max-w-sm">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

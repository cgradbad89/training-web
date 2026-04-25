'use client'

import { useState } from 'react'

interface EfficiencyTooltipProps {
  children: React.ReactNode
}

export function EfficiencyTooltip({ children }: EfficiencyTooltipProps) {
  const [open, setOpen] = useState(false)

  return (
    // Outer wrapper: relative container only — no `group` to avoid inheriting
    // parent row's group-hover (the runs list row has its own `group` class).
    <div className="relative inline-block">
      {/* peer: tooltip responds to THIS element's hover, not the row's */}
      <div
        className="peer flex items-center gap-0.5 cursor-help"
        onMouseLeave={() => setOpen(false)}
      >
        {children}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v) }}
          className="text-textSecondary text-[9px] shrink-0 leading-none select-none outline-none"
          tabIndex={-1}
          aria-label="Efficiency score explanation"
        >
          ⓘ
        </button>
      </div>
      {/* Tooltip — peer-hover scopes to the sibling badge wrapper only */}
      <div
        role="tooltip"
        className={[
          'absolute bottom-full right-0 mb-2 z-50 w-48',
          'bg-card border border-border rounded-lg p-3 shadow-lg',
          'pointer-events-none transition-opacity duration-150',
          open
            ? 'opacity-100 visible'
            : 'opacity-0 invisible peer-hover:opacity-100 peer-hover:visible',
        ].join(' ')}
      >
        <p className="font-medium text-textPrimary mb-1.5 text-xs">Efficiency Score</p>
        <p className="text-textSecondary mb-2 text-[11px]">
          How well your pace matches your heart rate effort.
        </p>
        <div className="space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-textPrimary">Elite</span>
            <span className="text-success">10.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textPrimary">Good</span>
            <span className="text-success">7.0+</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textPrimary">Average</span>
            <span className="text-warning">5.0+</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textPrimary">Below avg</span>
            <span className="text-warning">3.0+</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textPrimary">Poor</span>
            <span className="text-danger">&lt; 3.0</span>
          </div>
        </div>
      </div>
    </div>
  )
}

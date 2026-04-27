'use client'

import { useState, useRef } from 'react'
import { getEfficiencyTiers } from '@/utils/metrics'

interface EfficiencyTooltipProps {
  children: React.ReactNode
  /** Run distance in miles. Used to pick the distance-adjusted tier set
   *  shown in the tooltip body. Defaults to the medium tier when absent. */
  distanceMiles?: number
}

export function EfficiencyTooltip({ children, distanceMiles }: EfficiencyTooltipProps) {
  const badgeRef = useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)
  // open = true means the tooltip was pinned open by clicking ⓘ (mobile)
  const [open, setOpen] = useState(false)

  function computePos() {
    if (!badgeRef.current) return null
    const rect = badgeRef.current.getBoundingClientRect()
    return { top: rect.top - 8, left: rect.left + rect.width / 2 }
  }

  const handleMouseEnter = () => setTooltipPos(computePos())
  // Only hide on mouse-leave if NOT click-pinned open
  const handleMouseLeave = () => { if (!open) setTooltipPos(null) }

  const handleIconClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (open) {
      setOpen(false)
      setTooltipPos(null)
    } else {
      setTooltipPos(computePos())
      setOpen(true)
    }
  }

  return (
    <div className="inline-flex items-center gap-0.5 cursor-help">
      <div
        ref={badgeRef}
        className="inline-flex items-center gap-0.5"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
        <button
          type="button"
          onClick={handleIconClick}
          className="text-textSecondary text-[9px] shrink-0 leading-none select-none outline-none"
          tabIndex={-1}
          aria-label="Efficiency score explanation"
        >
          ⓘ
        </button>
      </div>

      {tooltipPos && (
        <>
          {/* Backdrop — only rendered in click-open state so tapping elsewhere closes */}
          {open && (
            <div
              className="fixed inset-0 z-[9998]"
              onClick={() => { setOpen(false); setTooltipPos(null) }}
            />
          )}
          {/* fixed positioning escapes all overflow-hidden containers */}
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: tooltipPos.top,
              left: tooltipPos.left,
              transform: 'translate(-50%, -100%)',
              zIndex: 9999,
            }}
            className="w-48 bg-card border border-border rounded-lg p-3 shadow-lg pointer-events-none"
          >
            <p className="font-medium text-textPrimary mb-1 text-xs">Efficiency Score</p>
            {(() => {
              // Default to the medium tier (3–8 mi) when no distance given.
              const { tierLabel, tiers } = getEfficiencyTiers(distanceMiles ?? 5)
              return (
                <>
                  <p className="text-[10px] text-textSecondary mb-1.5">{tierLabel}</p>
                  <p className="text-textSecondary mb-2 text-[11px]">
                    How well your pace matches your heart rate effort.
                  </p>
                  <div className="space-y-1 text-[11px]">
                    {tiers.map((tier, i) => {
                      const colorClass =
                        tier.color === 'success'
                          ? 'text-success'
                          : tier.color === 'warning'
                            ? 'text-warning'
                            : 'text-danger'
                      const range =
                        i === tiers.length - 1
                          ? `< ${tiers[i - 1].min.toFixed(1)}`
                          : `${tier.min.toFixed(1)}+`
                      return (
                        <div key={tier.label} className="flex justify-between">
                          <span className="text-textPrimary">{tier.label}</span>
                          <span className={colorClass}>{range}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )
            })()}
          </div>
        </>
      )}
    </div>
  )
}

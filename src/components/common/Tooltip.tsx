import { useState, type ReactNode } from 'react'

interface TooltipProps {
  content: string
  children: ReactNode
  position?: 'top' | 'right' | 'bottom' | 'left'
}

export function Tooltip({ content, children, position = 'right' }: TooltipProps) {
  const [show, setShow] = useState(false)

  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  }

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className={`absolute z-50 px-3 py-1.5 text-sm font-medium bg-bg-primary border border-border rounded-md text-text-primary whitespace-nowrap shadow-lg pointer-events-none ${positions[position]}`}
        >
          {content}
        </div>
      )}
    </div>
  )
}

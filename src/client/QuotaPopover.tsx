import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'

export function QuotaPopover({remaining, children}: {remaining?: number; children: ReactNode}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const id = useId()
  const close = useCallback(() => {
    clearTimeout(timer.current)
    setOpen(false)
    setPinned(false)
  }, [])
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (open) panel.showPopover()
    else if (panel.matches(':popover-open')) panel.hidePopover()
  }, [open])
  const position = useAnchoredPosition({open, anchorRef, panelRef, side: 'top', align: 'end', gap: 8, margin: 12})
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchorRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) close()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      else if (event.key === 'Tab') close()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', keydown, true)
      window.removeEventListener('blur', close)
    }
  }, [open, close])
  const leave = () => {
    clearTimeout(timer.current)
    if (!pinned) timer.current = setTimeout(close, 160)
  }
  return <>
    <Button ref={anchorRef} type="button" size="sm" variant="ghost" aria-label="查看额度"
      aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined}
      onMouseEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(() => { setOpen(true) }, 180) }}
      onMouseLeave={leave}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) { clearTimeout(timer.current); setOpen(true) } }}
      onClick={() => { clearTimeout(timer.current); if (pinned) close(); else { setPinned(true); setOpen(true) } }}
      style={{width: 28, minWidth: 28, padding: 0, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)'}}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        {remaining !== undefined && <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"
          pathLength="100" strokeDasharray={`${remaining} 100`} transform="rotate(-90 12 12)" />}
        <circle cx="12" cy="12" r="2" fill="currentColor" />
      </svg>
    </Button>
    <div ref={panelRef} id={id} role="tooltip" {...{popover: 'manual'}}
      onMouseEnter={() => { clearTimeout(timer.current) }} onMouseLeave={leave}
      style={{position: 'fixed', inset: 'auto', margin: 0, ...position, visibility: position ? 'visible' : 'hidden',
        width: 244, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
        boxSizing: 'border-box', padding: 16, border: 0, borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'var(--dsw-elevation-panel)', fontSize: 12, lineHeight: 1.5}}>
      {children}
    </div>
  </>
}

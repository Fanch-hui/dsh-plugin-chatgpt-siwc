import { useEffect, useSyncExternalStore } from 'react'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SiwcController } from './controller.js'
import { formatQuotaTime, quotaIndicator } from './quota-indicator.js'
import { QuotaPopover } from './QuotaPopover.js'

const secondary = 'var(--dsw-alias-label-secondary)'
export function QuotaIndicator({controller, directory}: {controller: SiwcController; directory: ModelDirectory['store']}) {
  const model = useSyncExternalStore(directory.subscribe, directory.getSnapshot)
  const {status} = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const visible = model.current?.provider === 'chatgpt-siwc'
  useEffect(() => visible ? controller.watchQuota() : undefined, [controller, visible])
  if (!visible || !status?.authenticated) return null
  const view = quotaIndicator(status, model.current?.model)
  return <QuotaPopover remaining={view.remaining}>
    <div style={{display: 'grid', gap: 16}}>
      {view.windows.map((window, index) => <div key={index} style={{display: 'grid', gap: 6}}>
        <div style={{display: 'flex', justifyContent: 'space-between', gap: 16}}>
          <span>{window.label}</span>
          <span style={{fontWeight: 500, fontVariantNumeric: 'tabular-nums'}}>剩余 {window.remaining}%</span>
        </div>
        <div role="progressbar" aria-label={`${window.label}剩余额度`} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={window.remaining} style={{height: 5, borderRadius: 3, overflow: 'hidden', background: 'var(--dsw-alias-interactive-bg-hover)'}}>
          <div style={{height: '100%', width: `${window.remaining}%`, borderRadius: 3, background: 'var(--dsw-alias-state-business-primary)'}} />
        </div>
        {window.resetsAt !== undefined && <span style={{color: secondary, fontSize: 11}}>{formatQuotaTime(window.resetsAt * 1000)} 重置</span>}
      </div>)}
      {view.message && <span style={{color: secondary}}>{view.message}</span>}
      {(view.credits || view.updatedAt !== undefined) && <div style={{display: 'grid', gap: 4, color: secondary, fontSize: 11}}>
        {view.credits && <span>{view.credits}</span>}
        {view.updatedAt !== undefined && <span>更新于 {formatQuotaTime(view.updatedAt)}{view.stale ? ' · 上次结果' : ''}</span>}
      </div>}
    </div>
  </QuotaPopover>
}

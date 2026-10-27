import { useEffect, useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SiwcStatus } from '../api/types.js'
import type { QuotaBucket, QuotaSnapshot } from '../quota/types.js'
import { QuotaAssociation } from './QuotaAssociation.js'
import type { SiwcController } from './controller.js'

const secondary = 'var(--dsw-alias-text-secondary)'
const border = '1px solid var(--dsw-alias-border-default, color-mix(in srgb, currentColor 14%, transparent))'
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const hint: CSSProperties = { fontSize: 12, lineHeight: 1.6, color: secondary, margin: 0 }

export function Quota({controller, status, pending, refreshing, error}: {controller: SiwcController; status: SiwcStatus; pending?: string; refreshing?: boolean; error?: string}) {
  useEffect(() => controller.watchQuota(), [controller])
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const codex = status.quota?.codex
  const connecting = codex?.state === 'connecting'
  const busy = Boolean(pending) || status.signingIn
  const connected = Boolean(codex?.snapshot || codex?.email || codex?.state === 'ready')
  let connectionAction = <Button size="sm" variant="outline" disabled={busy} onClick={() => { void controller.run('connectCodexQuota') }}>连接 Codex 查看额度</Button>
  if (connecting) connectionAction = <Button size="sm" disabled={Boolean(pending)} onClick={() => { void controller.run('cancelCodexQuota') }}>取消登录</Button>
  else if (connected) connectionAction = <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setConfirmDisconnect(true) }}>退出额度连接</Button>
  return <section aria-label="订阅额度" style={{borderTop: border, padding: '24px 0'}}>
    <div style={{...row, justifyContent: 'space-between', marginBottom: 16}}>
      <h3 style={{fontSize: 14, fontWeight: 600, margin: 0}}>订阅额度</h3>
      <Button size="sm" variant="ghost" disabled={busy || connecting || refreshing} onClick={() => { void controller.run('refreshQuota') }}>
        {refreshing ? '正在刷新…' : '刷新额度'}
      </Button>
    </div>
    {error && <p role="status" style={hint}>{error}</p>}
    <div style={{display: 'grid', gap: 12}}>
      <div style={{...row, justifyContent: 'space-between', columnGap: 20}}>
        <div style={{minWidth: 0, flex: '1 1 240px'}}>
          <h4 style={{fontSize: 13, fontWeight: 500, margin: 0}}>Codex 额度 · 独立连接</h4>
          {codex?.email && <p style={{...hint, marginTop: 4, overflowWrap: 'anywhere'}}>{codex.email}{codex.planType ? ` · ${codex.planType}` : ''}</p>}
        </div>
        <div style={row}>{connectionAction}</div>
      </div>
      {connecting && <p role="status" style={hint}>请在浏览器中完成 Codex 登录。</p>}
      {!connected && !connecting && <p style={hint}>登录后显示该 Codex 账号的额度，聊天账号仍在上方选择。</p>}
      <QuotaAssociation controller={controller} status={status} busy={busy || Boolean(refreshing)} />
      {codex?.snapshot && <Snapshot snapshot={codex.snapshot} label="Codex 独立连接" />}
      {codex?.error && <p role="status" style={hint}>{codex.error}</p>}
      {confirmDisconnect && <div style={row} role="group" aria-label="确认退出额度连接">
        <span style={{...hint, flex: '1 1 220px'}}>确认退出此 Codex 额度连接？</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setConfirmDisconnect(false) }}>取消</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setConfirmDisconnect(false); void controller.run('disconnectCodexQuota') }}>确认退出</Button>
      </div>}
    </div>
  </section>
}

function Snapshot({snapshot, label}: {snapshot: QuotaSnapshot; label: string}) {
  return <div aria-label={label} style={{display: 'grid', gap: 14}}>
    {snapshot.buckets.map(bucket => <div key={bucket.id} style={{display: 'grid', gap: 10}}>
      <div style={row}>
        <span style={{fontSize: 13, fontWeight: 500}}>{bucket.name ?? (bucket.id === 'codex' ? 'Codex' : bucket.id)}</span>
        {bucket.planType && <span style={hint}>{bucket.planType}</span>}
      </div>
      {bucket.windows.map((window, index) => {
        const remaining = Math.round((100 - window.usedPercent) * 10) / 10
        const windowLabel = duration(window.windowDurationMins)
        return <div key={index} style={{display: 'grid', gap: 5}}>
          <div style={{...row, justifyContent: 'space-between', fontSize: 12}}>
            <span>{windowLabel}额度</span>
            <span style={{fontVariantNumeric: 'tabular-nums'}}>剩余 {remaining}%</span>
          </div>
          <progress value={remaining} max={100} aria-label={`${label} ${windowLabel}额度剩余 ${remaining}%`}
            style={{display: 'block', width: '100%', height: 6, accentColor: 'var(--dsw-alias-text-primary)'}} />
          {window.resetsAt && <p style={hint}>{dateTime(window.resetsAt * 1000)}重置</p>}
        </div>
      })}
      {bucket.credits && <p style={hint}>{creditsLabel(bucket.credits)}</p>}
      {!bucket.windows.length && !bucket.credits && <p style={hint}>暂未提供额度窗口。</p>}
    </div>)}
    {!snapshot.buckets.length && <p style={hint}>服务暂未提供额度数据。</p>}
    <p style={hint}>更新于 {dateTime(snapshot.updatedAt)}</p>
  </div>
}

function duration(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

function dateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '时间待更新' : date.toLocaleString(undefined, {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})
}

function creditsLabel(credits: NonNullable<QuotaBucket['credits']>): string {
  if (credits.unlimited) return '积分不限量'
  if (credits.balance !== undefined) return `可用积分：${credits.balance}`
  return '积分余额暂未提供'
}

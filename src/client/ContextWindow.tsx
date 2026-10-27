import { useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SiwcStatus } from '../api/types.js'
import type { SiwcController } from './controller.js'

const hint: CSSProperties = {margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)'}
const row: CSSProperties = {display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8}

export function ContextWindow({accountId, model, controller, busy}: {
  accountId: string
  model: SiwcStatus['models'][number]
  controller: SiwcController
  busy: boolean
}) {
  const [value, setValue] = useState(model.contextWindowOverride?.toString() ?? '')
  const trimmed = value.trim()
  const number = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  const valid = Number.isSafeInteger(number) && number > 0
  const aboveMaximum = valid && model.maxContextWindow !== undefined && number > model.maxContextWindow
  const invalid = trimmed.length > 0 && (!valid || aboveMaximum)
  const changed = valid && number !== model.contextWindowOverride
  const save = (contextWindow: number | null) => {
    void controller.run('setContextWindow', {accountId, modelId: model.id, contextWindow})
  }
  return <div style={{display: 'grid', gap: 10, margin: '16px 0'}}>
    <label htmlFor="dsh-siwc-context-window">上下文窗口（token）</label>
    <div style={row}>
      <input id="dsh-siwc-context-window" type="text" inputMode="numeric" value={value}
        placeholder={model.defaultContextWindow?.toString() ?? '使用服务端默认值'}
        disabled={busy} aria-invalid={invalid} aria-describedby="dsh-siwc-context-details"
        onChange={event => { setValue(event.target.value) }}
        style={{color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)',
          border: '1px solid var(--dsw-alias-border-default, color-mix(in srgb, currentColor 14%, transparent))',
          borderRadius: 6, padding: '6px 10px', font: 'inherit', flex: '1 1 200px', minWidth: 0}} />
      <Button size="sm" variant="outline" disabled={busy || !changed || invalid} onClick={() => { save(number) }}>保存</Button>
      <Button size="sm" variant="ghost" disabled={busy || model.contextWindowOverride === undefined}
        onClick={() => { save(null) }}>恢复默认</Button>
    </div>
    {invalid && <p role="alert" style={hint}>{aboveMaximum
      ? `请输入不超过 ${model.maxContextWindow!.toLocaleString()} 的数值。`
      : '请输入正整数 token 数。'}</p>}
    <div id="dsh-siwc-context-details" style={{display: 'grid', gap: 4}}>
      <p style={hint}>当前：{tokens(model.contextWindow)} · 默认：{tokens(model.defaultContextWindow)} · 最大：{tokens(model.maxContextWindow)}</p>
      <p style={hint}>保存后，后续请求的上下文计算与自动压缩使用新值。实际容量由服务端决定。</p>
    </div>
  </div>
}

function tokens(value?: number): string { return value === undefined ? '未知' : value.toLocaleString() }

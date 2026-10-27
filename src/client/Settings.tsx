import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SiwcStatus } from '../api/types.js'
import type { SiwcController } from './controller.js'
import { Quota } from './Quota.js'
import { ContextWindow } from './ContextWindow.js'
import { Diagnostics } from './Diagnostics.js'

const usageUrl = 'https://chatgpt.com/settings/usage'
const secondary = 'var(--dsw-alias-text-secondary)'
const border = '1px solid var(--dsw-alias-border-default, color-mix(in srgb, currentColor 14%, transparent))'
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const spread: CSSProperties = { ...row, justifyContent: 'space-between', columnGap: 20 }
const hint: CSSProperties = { margin: 0, color: secondary, fontSize: 12, lineHeight: 1.6 }

export function Settings({ controller }: { controller: SiwcController }) {
  const { status, pending, error, statusPending, quotaPending, modelsPending, quotaError, modelsError } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    let loaded = false
    const loadModels = () => {
      const current = controller.getSnapshot()
      if (loaded || !current.status || current.pending || current.modelsPending) return
      loaded = true
      if (current.status.authenticated && current.status.planEnabled && !current.status.models.length) void controller.run('refreshModels')
    }
    const unsubscribe = controller.subscribe(loadModels)
    void controller.run('status').then(loadModels)
    return unsubscribe
  }, [controller])
  const busy = Boolean(pending)
  if (!status) return <div role="status" style={{ fontSize: 14 }}>{error ?? '正在读取连接状态…'}{error && <Button size="sm" onClick={() => { void controller.run('status') }}>重试</Button>}</div>
  return (
    <div style={{ color: 'var(--dsw-alias-text-primary)', fontSize: 14, lineHeight: 1.5, maxWidth: 720, width: '100%', minWidth: 0 }} aria-label="ChatGPT 连接设置" aria-busy={busy}>
      {(error || status.error) && <p role="alert" style={{ margin: '0 0 20px', overflowWrap: 'anywhere' }}>{error ?? status.error}</p>}
      <Accounts status={status} controller={controller} busy={busy} refreshing={statusPending} />
      {status.authenticated && <Models key={status.activeAccountId} status={status} controller={controller} busy={busy} loading={modelsPending} error={modelsError} />}
      <Quota status={status} controller={controller} pending={pending} refreshing={quotaPending} error={quotaError} />
      {status.authenticated && <>
        <Section title="用量" action={<a href={usageUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>在 ChatGPT 中查看</a>}>
          <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: '20px 16px', margin: '0 0 14px' }}>
            <Usage label="完成请求" value={status.usage.requests} />
            <Usage label="输入 token" value={status.usage.inputTokens} />
            <Usage label="输出 token" value={status.usage.outputTokens} />
            <Usage label="缓存 token" value={status.usage.cachedTokens} />
            <Usage label="缓存命中率" value={cacheHitRate(status.usage)} />
          </dl>
          <p style={hint}>当前账号在此插件中的本地统计。输入 token 包含缓存命中；命中率仅统计服务端提供缓存计量的请求。</p>
        </Section>
        <Diagnostics diagnostics={status.diagnostics} controller={controller} busy={busy} />
        <details style={{ paddingTop: 20, borderTop: border }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>高级设置</summary>
          <div style={{ ...spread, alignItems: 'flex-start', marginTop: 16 }}>
            <div style={{ flex: '1 1 260px' }}>
              <span>允许独立调用使用计划</span>
              <p style={{ ...hint, marginTop: 4 }}>默认开启，用于工具自动审核等独立请求。关闭后，自动审核可能无法运行。</p>
            </div>
            <Switch checked={status.allowBackground} label="允许独立调用使用 ChatGPT 计划" disabled={busy || !status.planEnabled}
              onChange={allowed => { void controller.run('setBackgroundAllowed', allowed) }} />
          </div>
          <CacheEnhancements status={status} controller={controller} busy={busy} />
        </details>
      </>}
    </div>
  )
}

function CacheEnhancements({ status, controller, busy }: { status: SiwcStatus; controller: SiwcController; busy: boolean }) {
  const settings = status.cacheSettings ?? {}
  const disabled = busy || !status.planEnabled
  const update = (patch: SiwcStatus['cacheSettings']) => {
    void controller.run('setCacheSettings', { ...settings, ...patch })
  }
  return <>
    <div style={{ ...spread, alignItems: 'center', marginTop: 16 }}>
      <label htmlFor="dsh-siwc-cache-ttl" style={{ flex: '1 1 260px' }}>缓存保留时长 (TTL)</label>
      <select id="dsh-siwc-cache-ttl" value={settings.ttl ?? ''} disabled={disabled}
        onChange={event => {
          const ttl = event.target.value === '30m' || event.target.value === '12h' ? event.target.value : undefined
          const next = { ...settings }
          if (ttl) next.ttl = ttl
          else delete next.ttl
          void controller.run('setCacheSettings', next)
        }}
        style={{ color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)', border, borderRadius: 6, padding: '6px 10px', font: 'inherit' }}>
        <option value="">服务端默认</option>
        <option value="30m">30 分钟</option>
        <option value="12h">12 小时</option>
      </select>
    </div>
    <div style={{ ...spread, alignItems: 'flex-start', marginTop: 14 }}>
      <span style={{ flex: '1 1 260px' }}>服务端缓存对比诊断</span>
      <Switch checked={Boolean(settings.comparisonDiagnostics)} label="启用服务端缓存对比诊断" disabled={disabled}
        onChange={comparisonDiagnostics => { update({ comparisonDiagnostics }) }} />
    </div>
    <div style={{ ...spread, alignItems: 'flex-start', marginTop: 14 }}>
      <span style={{ flex: '1 1 260px' }}>配置增量追加</span>
      <Switch checked={Boolean(settings.configurationUpdate)} label="启用配置增量追加" disabled={disabled}
        onChange={configurationUpdate => { update({ configurationUpdate }) }} />
    </div>
    <div style={{ ...spread, alignItems: 'flex-start', marginTop: 14 }}>
      <span style={{ flex: '1 1 260px' }}>工具增量追加</span>
      <Switch checked={Boolean(settings.toolAdditions)} label="启用工具增量追加" disabled={disabled}
        onChange={toolAdditions => { update({ toolAdditions }) }} />
    </div>
  </>
}

function Accounts({ status, controller, busy, refreshing }: { status: SiwcStatus; controller: SiwcController; busy: boolean; refreshing?: boolean }) {
  const [removing, setRemoving] = useState<string>()
  const locked = busy || status.signingIn
  return <Section title="账号" first action={<Button size="sm" variant="ghost" disabled={busy || refreshing} onClick={() => { void controller.run('status') }}>{refreshing ? '正在刷新…' : '刷新状态'}</Button>}>
    {status.accounts.length > 0 ? <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
      {status.accounts.map((account) => {
        const current = account.id === status.activeAccountId
        const repeatedEmail = account.email && status.accounts.filter(item => item.email === account.email).length > 1
        const name = account.email ?? `账号 ${account.id.slice(0, 8)}`
        return <li key={account.id} style={{ padding: '14px 0', borderBottom: border }}>
          <div style={spread}>
            <div style={{ ...row, minWidth: 0, flex: '1 1 240px', gap: 10 }}>
              <span style={{ fontWeight: current ? 600 : 400, overflowWrap: 'anywhere', minWidth: 0 }}>{name}{repeatedEmail && <span style={{ color: secondary, fontSize: 12, marginLeft: 8 }}>{account.id.slice(0, 8)}</span>}</span>
              {current && <Tag tone="info">{account.authenticated ? '当前使用' : '当前账号'}</Tag>}
              {!account.authenticated && <span style={{ color: secondary, fontSize: 12 }}>需要登录</span>}
            </div>
            <div style={row}>
              {!current && account.authenticated && <Button size="sm" variant="outline" disabled={locked} onClick={() => { setRemoving(undefined); void controller.run('switchAccount', account.id) }}>切换</Button>}
              {(!account.authenticated || current || !account.planEnabled) && <Button size="sm" variant="ghost" disabled={locked} onClick={() => { void controller.run('reauthorizeAccount', account.id) }}>{account.authenticated ? '重新授权' : '重新登录'}</Button>}
              {account.authenticated && <Button size="sm" variant="ghost" disabled={locked} onClick={() => { setRemoving(account.id) }}>退出</Button>}
            </div>
          </div>
          {removing === account.id && <div style={{ ...row, marginTop: 12 }} role="group" aria-label="确认退出账号">
            <span style={{ fontSize: 12, flex: '1 1 220px' }}>退出后将清除此账号的本机登录。</span>
            <Button size="sm" variant="outline" disabled={locked} onClick={() => { setRemoving(undefined) }}>取消</Button>
            <Button size="sm" disabled={locked} onClick={() => { setRemoving(undefined); void controller.run('removeAccount', account.id) }}>确认退出</Button>
          </div>}
        </li>
      })}
    </ul> : <p style={{ margin: '0 0 16px', color: secondary }}>登录 ChatGPT，使用订阅计划中的模型。</p>}
    <div style={row}>
      <Button size="sm" variant={status.accounts.length ? 'outline' : 'primary'} disabled={locked} onClick={() => { void controller.run('addAccount') }}>
        {status.accounts.length ? '添加账号' : 'Continue with ChatGPT'}
      </Button>
      {status.signingIn && <>
        <span role="status" style={{ ...hint, flex: '1 1 180px' }}>请在浏览器中完成登录。</span>
        <Button size="sm" disabled={busy} onClick={() => { void controller.run('cancelSignIn') }}>取消登录</Button>
      </>}
    </div>
    {status.authenticated && !status.planEnabled && <p role="status" style={{ ...hint, marginTop: 12 }}>当前账号尚未授权使用 ChatGPT 计划，请重新登录完成授权。</p>}
  </Section>
}

function Models({ status, controller, busy, loading, error }: { status: SiwcStatus; controller: SiwcController; busy: boolean; loading?: boolean; error?: string }) {
  const [selectedModel, setSelectedModel] = useState('')
  const modelId = status.models.some(model => model.id === selectedModel) ? selectedModel : status.models[0]?.id ?? ''
  const model = status.models.find(model => model.id === modelId)
  return <Section title="模型" action={<Button size="sm" variant="ghost" disabled={busy || loading || !status.planEnabled} onClick={() => { void controller.run('refreshModels') }}>{loading ? '正在刷新…' : '刷新模型'}</Button>}>
    {error && <p role="status" style={hint}>{error}</p>}
    <p style={{ margin: '0 0 12px' }}>{status.models.length ? `${status.models.length} 个模型可用，聊天时在 DSH 模型选择器中选择。` : '暂无模型，请刷新模型目录。'}</p>
    {status.availability === 'usage-limited' && <p role="status" style={{ ...hint, marginBottom: 12 }}>已达到用量限制，请在 ChatGPT 中查看额度，恢复后刷新模型。</p>}
    {status.availability === 'unavailable' && <p role="status" style={{ ...hint, marginBottom: 12 }}>连接暂时不可用，请刷新模型重试。</p>}
    <div style={row}>
      <label htmlFor="dsh-siwc-model">模型</label>
      <select id="dsh-siwc-model" value={modelId} disabled={busy || !status.models.length} onChange={event => { setSelectedModel(event.target.value) }}
        style={{ color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)', border, borderRadius: 6, padding: '6px 10px', font: 'inherit', flex: '1 1 220px', minWidth: 0, maxWidth: '100%' }}>
        {!status.models.length && <option value="">请先刷新模型</option>}
        {status.models.map(model => <option key={model.id} value={model.id}>{model.name}{model.verified ? ' · 已验证' : ''}</option>)}
      </select>
    </div>
    {model && status.activeAccountId && <ContextWindow
      key={`${status.activeAccountId}:${model.id}:${model.contextWindowOverride ?? 'default'}`}
      accountId={status.activeAccountId} model={model} controller={controller} busy={busy} />}
    <details style={{marginTop: 16}}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>连接诊断</summary>
      <div style={{ ...row, marginTop: 14 }}>
        <Button size="sm" variant="outline" disabled={busy || !modelId || !status.planEnabled} onClick={() => { void controller.run('probeModel', modelId) }}>验证当前模型</Button>
      </div>
      <p style={{ ...hint, marginTop: 8 }}>验证会发送一条简短请求，使用少量计划用量。</p>
    </details>
  </Section>
}

function Section({ title, action, first, children }: { title: string; action?: ReactNode; first?: boolean; children: ReactNode }) {
  return <section aria-label={title} style={{ padding: first ? '0 0 24px' : '24px 0', borderTop: first ? undefined : border }}>
    <div style={{ ...spread, marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h3>
      {action}
    </div>
    {children}
  </section>
}

function cacheHitRate(usage: SiwcStatus['usage']): string {
  if (!usage.cacheMeasuredInputTokens || usage.cacheMeasuredTokens === undefined) return '—'
  return `${(usage.cacheMeasuredTokens / usage.cacheMeasuredInputTokens * 100).toFixed(1)}%`
}

function Usage({ label, value }: { label: string; value: number | string }) {
  return <div><dt style={{ color: secondary, fontSize: 12 }}>{label}</dt><dd style={{ fontSize: 20, fontWeight: 500, fontVariantNumeric: 'tabular-nums', margin: '6px 0 0' }}>{value.toLocaleString()}</dd></div>
}

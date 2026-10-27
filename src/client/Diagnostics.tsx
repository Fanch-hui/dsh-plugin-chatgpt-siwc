import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  exportDiagnosticsCsv,
  exportDiagnosticsJson,
  findReconnectBaseline,
  recordCacheWriteTokens,
  recordOtherInputTokens,
  unifiedMetrics,
  type UnifiedDiagnosticMetrics,
} from '../diagnostics/export.js'
import type { DiagnosticsFilter, DiagnosticsSnapshot, RequestCategory, RequestDiagnostic } from '../diagnostics/types.js'
import type { SiwcController } from './controller.js'
import { diagnosticExplanation } from './diagnostic-explanation.js'

const secondary = 'var(--dsw-alias-text-secondary)'
const border = '1px solid var(--dsw-alias-border-default, color-mix(in srgb, currentColor 14%, transparent))'
const hint: CSSProperties = {margin: 0, color: secondary, fontSize: 12, lineHeight: 1.6}
const row: CSSProperties = {display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12}
const cell: CSSProperties = {padding: '9px 10px', textAlign: 'left', borderBottom: border, verticalAlign: 'top', whiteSpace: 'nowrap'}
const selectStyle: CSSProperties = {fontSize: 12, padding: '4px 8px', borderRadius: 4, border, background: 'transparent', color: 'inherit'}
const categories: Record<RequestCategory, string> = {
  conversation: '主会话', subagent: '子智能体', compaction: '上下文压缩',
  'session-title': '会话标题', independent: '独立调用', 'connection-test': '连接验证',
}
const modes: Record<RequestDiagnostic['transport'][number]['mode'], string> = {
  'ws-full': 'WebSocket 全量', 'ws-incremental': 'WebSocket 增量',
  'http-fallback': 'HTTP 回退', http: 'HTTP', 'not-started': '尚未发送',
}
const reasons: Record<string, string> = {
  'cold-connection': '新连接', 'no-baseline': '没有续接基线', 'unconfirmed-response': '前序响应未确认持久化',
  'settings-changed': '请求设置变化', 'prefix-changed': '历史前缀变化', continued: '增量续接',
  'previous-response-missing': '服务端前序响应失效', 'socket-fallback': '连接失败后回退',
  'independent-call': '无会话归属', 'websocket-disabled': 'WebSocket 已关闭', 'not-started': '尚未发送',
  'ws-cooldown': 'WebSocket 冷却期', 'planned-rotation': '连接寿命主动轮换',
  'connection-limit': '达到连接时长上限', 'health-check-failed': '连接探活失败',
}
const outcomes: Record<RequestDiagnostic['outcome'], string> = {completed: '完成', failed: '失败', cancelled: '取消'}

export function Diagnostics({diagnostics, controller, busy}: {
  diagnostics?: DiagnosticsSnapshot
  controller: SiwcController
  busy: boolean
}) {
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [modelFilter, setModelFilter] = useState<string>('all')
  const [reasonFilter, setReasonFilter] = useState<string>('all')
  const [exportStatus, setExportStatus] = useState<string>()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<{source: DiagnosticsSnapshot; key: string; snapshot: DiagnosticsSnapshot}>()
  const [queryError, setQueryError] = useState<string>()

  const hasFilter = categoryFilter !== 'all' || modelFilter !== 'all' || reasonFilter !== 'all'
  const filterKey = JSON.stringify([categoryFilter, modelFilter, reasonFilter])
  const currentQuery = query?.source === diagnostics && query?.key === filterKey ? query : undefined
  const selected = currentQuery?.snapshot ?? (hasFilter ? undefined : diagnostics)
  const recent = selected?.recent ?? []
  const records = selected?.records ?? recent
  const models = diagnostics?.models ?? [...new Set((diagnostics?.recent ?? []).map(record => record.model))]
  const metrics = selected?.metrics ?? unifiedMetrics(records)
  const loading = open && !currentQuery && !queryError

  useEffect(() => {
    if (!open || !diagnostics) return
    let active = true
    setQueryError(undefined)
    setExportStatus(undefined)
    const filter: DiagnosticsFilter = {category: categoryFilter as RequestCategory | 'all', model: modelFilter, reason: reasonFilter}
    void controller.queryDiagnostics(filter).then(snapshot => {
      if (active) setQuery({source: diagnostics, key: filterKey, snapshot})
    }).catch(() => {
      if (active) setQueryError('诊断查询失败，请刷新重试。')
    })
    return () => { active = false }
  }, [open, diagnostics, controller, categoryFilter, modelFilter, reasonFilter, filterKey])

  const handleExport = async (kind: 'json' | 'csv') => {
    if (!currentQuery) return
    try {
      const content = kind === 'json'
        ? exportDiagnosticsJson(currentQuery.snapshot)
        : exportDiagnosticsCsv(currentQuery.snapshot)
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
        setExportStatus(`已复制 ${kind.toUpperCase()} 到剪贴板`)
      } else {
        setExportStatus(`已生成 ${kind.toUpperCase()}（${content.length} 字节）`)
      }
    } catch {
      setExportStatus('导出失败')
    }
  }

  return <details style={{borderTop: border, padding: '20px 0'}} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary style={{cursor: 'pointer', fontSize: 13}}>缓存诊断</summary>
    <div style={{display: 'grid', gap: 16, marginTop: 16}}>
      <div style={row}>
        <p style={hint}>已保留 {diagnostics?.retained ?? 0} / {diagnostics?.limit ?? 2000} 条请求{hasFilter && selected ? ` · 匹配 ${selected.retained} 条` : ''}{selected?.since ? ` · 自 ${dateTime(selected.since)}` : ''}</p>
        <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
          {diagnostics && diagnostics.retained > 0 && <>
            <Button size="sm" variant="ghost" disabled={busy || !currentQuery} onClick={() => { void handleExport('json') }}>复制 JSON</Button>
            <Button size="sm" variant="ghost" disabled={busy || !currentQuery} onClick={() => { void handleExport('csv') }}>复制 CSV</Button>
          </>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void controller.run('status') }}>刷新诊断</Button>
        </div>
      </div>
      {exportStatus && <p role="status" style={hint}>{exportStatus}</p>}
      {loading && <p role="status" style={hint}>正在读取全部匹配记录…</p>}
      {queryError && <p role="status" style={hint}>{queryError}</p>}
      <p style={hint}>只记录统计与哈希；已有任务不追溯。独立调用的具体来源未识别。</p>
      {(selected?.storageError ?? diagnostics?.storageError) && <p role="status" style={hint}>{selected?.storageError ?? diagnostics?.storageError}</p>}
      {!diagnostics?.retained ? <p style={hint}>发起新任务后，可在这里查看缓存用量和续接决策。</p> : <>
        <Table label="按请求类型汇总缓存诊断" headings={['请求类型', '已计量 / 请求数', '失败或取消', '未缓存输入', '缓存命中', '缓存写入', '输出', '累计请求耗时']}>
          {(selected?.groups ?? []).map(group => <tr key={group.category}>
            <th scope="row" style={{...cell, fontWeight: 400}}>{categories[group.category]}</th>
            <td style={cell}>{group.measuredRequests} / {group.requests}</td>
            <td style={cell}>{group.failed}</td>
            <td style={cell}>{format(group.inputTokens - group.cachedTokens)}</td>
            <td style={cell}>{hitRate(group.inputTokens, group.cachedTokens)}</td>
            <td style={cell}>{group.cacheWriteTokens === undefined ? '—' : format(group.cacheWriteTokens)}</td>
            <td style={cell}>{format(group.outputTokens)}</td>
            <td style={cell}>{duration(group.durationMs)}</td>
          </tr>)}
        </Table>
        <p style={hint}>命中率按已计量的输入 token 计算；耗时为各请求累计值，并行请求的耗时会重叠。</p>
        <Decisions reasonsList={selected?.reasons ?? []} metrics={metrics} />
        <FilterBar
          categoryFilter={categoryFilter} onCategory={setCategoryFilter}
          modelFilter={modelFilter} onModel={setModelFilter} models={models}
          reasonFilter={reasonFilter} onReason={setReasonFilter} reasonsList={diagnostics.reasons.map(r => r.reason)}
        />
        <Recent records={recent} allRecords={records} />
      </>}
    </div>
  </details>
}

function FilterBar(props: {
  categoryFilter: string; onCategory: (v: string) => void
  modelFilter: string; onModel: (v: string) => void; models: string[]
  reasonFilter: string; onReason: (v: string) => void; reasonsList: string[]
}) {
  return <div style={{...row, justifyContent: 'flex-start', gap: 10, fontSize: 12}}>
    <label>类型 <select style={selectStyle} value={props.categoryFilter} onChange={e => props.onCategory(e.target.value)}>
      <option value="all">全部</option>
      {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>模型 <select style={selectStyle} value={props.modelFilter} onChange={e => props.onModel(e.target.value)}>
      <option value="all">全部</option>
      {props.models.map(m => <option key={m} value={m}>{m}</option>)}
    </select></label>
    <label>连接事件 <select style={selectStyle} value={props.reasonFilter} onChange={e => props.onReason(e.target.value)}>
      <option value="all">全部</option>
      {props.reasonsList.map(r => <option key={r} value={r}>{reasons[r] ?? r}</option>)}
    </select></label>
  </div>
}

function Decisions({reasonsList, metrics}: {reasonsList: {reason: string; requests: number}[]; metrics: UnifiedDiagnosticMetrics}) {
  return <div style={{display: 'grid', gap: 8}}>
    <strong style={{fontSize: 12, fontWeight: 500}}>续接决策与样本统计</strong>
    <div style={{...row, justifyContent: 'flex-start', gap: '6px 18px', fontSize: 12}}>
      {reasonsList.map(item => <span key={item.reason}>{reasons[item.reason] ?? item.reason}：{item.requests}</span>)}
      {!reasonsList.length && <span style={hint}>暂未记录传输决策。</span>}
    </div>
    <p style={hint}>
      缓存读取率：{metrics.cacheReadRate === undefined ? '未知' : `${(metrics.cacheReadRate * 100).toFixed(1)}%`}
      {' · '}计量覆盖率：{metrics.meteringCoverageRate === undefined ? '未知' : `${(metrics.meteringCoverageRate * 100).toFixed(1)}%`}
      {' · '}其他输入量：{metrics.otherInputTokens === undefined ? '未知' : format(metrics.otherInputTokens)}
      {metrics.missingCacheSamples > 0 ? ` · 缓存计量缺失样本 ${metrics.missingCacheSamples} 条` : ''}
    </p>
  </div>
}

function Recent({records, allRecords}: {records: RequestDiagnostic[]; allRecords: RequestDiagnostic[]}) {
  return <div style={{display: 'grid', gap: 8}}>
    <strong style={{fontSize: 12, fontWeight: 500}}>最近 {records.length} 条请求</strong>
    <Table label="最近请求的缓存和传输详情" headings={['时间 / 模型', '类型 / 状态', '未缓存 / 缓存 / 输出', '命中率', '耗时', '传输与前缀']}>
      {records.map(record => {
        const previous = findReconnectBaseline(record, allRecords)
        return <tr key={record.id}>
          <td style={cell}><div>{dateTime(record.startedAt)}</div><div style={{color: secondary, maxWidth: 220, overflowWrap: 'anywhere', whiteSpace: 'normal'}}>{record.model}</div></td>
          <td style={cell}><div>{categories[record.category]}</div><div style={{color: secondary}}>{outcomes[record.outcome]}</div></td>
          <td style={cell}>{usageText(record)}</td>
          <td style={cell}>{hitRate(record.inputTokens, record.cachedTokens)}</td>
          <td style={cell}>{duration(record.durationMs)}</td>
          <td style={{...cell, minWidth: 220, maxWidth: 360, whiteSpace: 'normal'}}><RequestDetails record={record} previous={previous} /></td>
        </tr>
      })}
    </Table>
  </div>
}

function usageText(record: RequestDiagnostic): string {
  if (record.inputTokens === undefined) return '未返回用量'
  const output = record.outputTokens === undefined ? '—' : format(record.outputTokens)
  if (record.cachedTokens === undefined) return `${format(record.inputTokens)} 总输入 / 缓存未提供 / ${output}`
  const write = recordCacheWriteTokens(record)
  const other = recordOtherInputTokens(record)
  const uncached = other !== undefined ? `${format(other)} 其他 + ${format(write!)} 写入` : format(record.inputTokens - record.cachedTokens)
  return `${uncached} / ${format(record.cachedTokens)} / ${output}`
}

function RequestDetails({record, previous}: {record: RequestDiagnostic; previous?: RequestDiagnostic}) {
  const prefix = record.prefix
  const explanation = diagnosticExplanation(record)
  return <details>
    <summary style={{cursor: 'pointer'}}>{explanation.summary}</summary>
    <div style={{display: 'grid', gap: 5, marginTop: 8}}>
      {explanation.evidence.map((line, index) => <span key={index}>{line}</span>)}
      {record.transport.map((decision, index) => <span key={index}>{modes[decision.mode]}：{reasons[decision.reason] ?? decision.reason}{decision.firstDifference === undefined ? '' : `，首个不同条目 ${decision.firstDifference + 1}`}</span>)}
      {previous && (record.routing?.connectionChanged || record.transport.some(t => t.connection?.state === 'new')) && (
        <span style={{color: secondary}}>
          同会话前序对照（{previous.id.slice(0, 8)}）：
          前次命中 {hitRate(previous.inputTokens, previous.cachedTokens)} → 本次 {hitRate(record.inputTokens, record.cachedTokens)}
          {record.timings?.firstContentMs !== undefined ? ` · 首内容 ${duration(record.timings.firstContentMs)}` : ''}
        </span>
      )}
      {prefix && <>
        <span>输入 {prefix.itemCount} 条{prefix.previousItemCount === undefined ? '' : `，前次 ${prefix.previousItemCount} 条`}{prefix.sharedItems === undefined ? '' : `，相同前缀 ${prefix.sharedItems} 条`}</span>
        {prefix.firstDifference !== undefined && <span>首个不同条目：{prefix.firstDifference + 1}</span>}
        <Hash label="指令" value={prefix.instructionsHash} />
        <Hash label="工具" value={prefix.toolsHash} />
        <Hash label="设置" value={prefix.settingsHash} />
        {prefix.policyHash && <Hash label="策略" value={prefix.policyHash} />}
        <Hash label="输入" value={prefix.inputHash} />
      </>}
    </div>
  </details>
}

function Hash({label, value}: {label: string; value: string}) {
  return <span style={{color: secondary}}>{label}哈希：<code>{value.slice(0, 12)}</code></span>
}
function Table({label, headings, children}: {label: string; headings: string[]; children: ReactNode}) {
  return <div role="region" aria-label={label} tabIndex={0} style={{overflowX: 'auto', maxWidth: '100%'}}>
    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums'}}>
      <thead><tr>{headings.map(heading => <th key={heading} scope="col" style={{...cell, color: secondary, fontWeight: 500}}>{heading}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
}
function hitRate(input?: number, cached?: number): string {
  return input === undefined || cached === undefined || input === 0 ? '—' : `${(cached / input * 100).toFixed(1)}%`
}
function format(value: number): string { return value.toLocaleString() }
function duration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`
  const seconds = Math.round(milliseconds / 1000)
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
function dateTime(timestamp: number): string { return new Date(timestamp).toLocaleString(undefined, {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'}) }

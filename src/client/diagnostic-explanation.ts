import type {
  DiagnosticConnectionCause,
  DiagnosticDisconnectCause,
  ReplayDegradeReason,
  RequestDiagnostic,
  ServerCacheDiagnosticReason,
  ServerCacheDiagnosticStatus,
  SystemPromptSource,
} from '../diagnostics/types.js'

const connectionCauses: Record<DiagnosticConnectionCause, string> = {
  'first-use': '首次使用', 'idle-expired': '空闲期限到期', 'capacity-evicted': '连接容量回收',
  'credential-rotated': '凭据轮换', invalidated: '连接失效清理', cancelled: '上次生成被停止',
  'remote-closed': '远端关闭', 'socket-error': '连接错误', timeout: '连接超时',
  'send-failed': '发送失败', 'handshake-failed': '握手失败', 'request-failed': '上次请求失败',
  'duplicate-idle': '同会话多余空闲连接', 'concurrent-call': '同会话并发请求',
  'planned-rotation': '连接寿命主动轮换', 'connection-limit': '达到服务端连接时长上限',
  'health-check-failed': '连接探活失败', unknown: '原因未记录',
}
const disconnectCauses: Record<DiagnosticDisconnectCause, string> = {
  'handshake-failed': '握手失败', 'remote-closed': '远端关闭',
  'socket-error': '连接错误', timeout: '连接超时', 'send-failed': '发送失败',
  'health-check-failed': '连接探活失败', 'connection-limit': '达到连接时长上限',
}
const durabilityLabels: Record<NonNullable<RequestDiagnostic['durability']>['reason'], string> = {
  'no-candidate': '没有可续接的前序响应', 'session-missing': '未找到会话', 'flush-failed': '会话历史保存失败',
  'history-mismatch': '前序响应与当前历史不匹配', confirmed: '前序响应已确认保存', error: '历史确认读取失败',
}
const failureLabels: Record<NonNullable<RequestDiagnostic['server']>['failure'] & string, string> = {
  'rate-limit': '用量或速率限制', authentication: '认证失败', 'context-limit': '上下文限制',
  'previous-response': '前序响应不可用', other: '其他服务端错误',
}
const serverStatuses: Record<NonNullable<RequestDiagnostic['server']>['status'] & string, string> = {
  completed: '完成', failed: '失败', incomplete: '未完成', cancelled: '取消', in_progress: '生成中',
}
const cacheDiagnosticStatuses: Record<ServerCacheDiagnosticStatus, string> = {
  cache_hit: '命中',
  cache_miss: '未命中',
  comparison_response_not_found: '比较基线响应未找到',
  unavailable: '不可用',
}
const cacheDiagnosticReasons: Record<ServerCacheDiagnosticReason, string> = {
  model: '模型变更',
  service_tier: '服务档位变更',
  tools: '工具定义变更',
  reasoning_effort: '推理强度变更',
  format: '输出格式变更',
  response_format: '输出格式变更',
  verbosity: '详略设置变更',
  compaction: '历史压缩',
  prefix_mismatch: '前缀不匹配',
  ttl_expired: '缓存期限到期',
  cache_evicted: '缓存已淘汰',
  unknown: '其他或未知原因',
}
const replayReasonLabels: Record<ReplayDegradeReason, string> = {
  intact: '完整保留',
  edited: '内容已编辑',
  compacted: '已压缩裁剪',
  reordered: '顺序已调整',
  'scope-changed': '授权域已变化',
  'model-changed': '模型已变化',
  'missing-metadata': '缺少原生元数据',
}
const systemPromptSourceLabels: Record<SystemPromptSource, string> = {
  'system-field': '顶层指令字段',
  'leading-message': '前导开发者消息',
  'in-history': '历史内开发者消息',
  none: '无系统指令',
}

export function diagnosticExplanation(record: RequestDiagnostic): {summary: string; evidence: string[]} {
  const evidence = routingEvidence(record)
  if (record.durability) {
    const confirmation = record.durability
    evidence.push(`持久化确认：${durabilityLabels[confirmation.reason]} · 候选 ${confirmation.candidates} 个 / 确认 ${confirmation.confirmed} 个`)
  }
  if (record.runtimeId) evidence.push(`本次运行 ${record.runtimeId.slice(0, 12)}`)
  if (record.baselineRequestId) evidence.push(`比较基线请求 ${record.baselineRequestId.slice(0, 12)}`)
  for (const decision of record.transport) {
    const connection = decision.connection
    if (!connection) continue
    const description = connection.state === 'reused' ? '复用已有连接' : `新建连接：${connectionCauses[connection.cause]}`
    const timings: string[] = []
    if (connection.idleMs !== undefined) timings.push(`距上次使用 ${elapsed(connection.idleMs)}`)
    if (connection.ageMs !== undefined) timings.push(`连接年龄 ${elapsed(connection.ageMs)}`)
    if (connection.socketGeneration !== undefined) timings.push(`连接代次 #${connection.socketGeneration}`)
    if (connection.closeCode !== undefined) timings.push(`关闭码 ${connection.closeCode}`)
    evidence.push([description, ...timings].join(' · '))
  }
  if (record.replay) {
    const parts = [`原生回放保留：${record.replay.nativeBlocks} / ${record.replay.totalBlocks} 块（降级 ${record.replay.degradedBlocks} 块）`]
    if (record.replay.reasons?.length) parts.push(`原因：${record.replay.reasons.map(reason => replayReasonLabels[reason]).join('、')}`)
    evidence.push(parts.join(' · '))
  }
  if (record.timings) {
    const parts: string[] = []
    if (record.timings.firstContentMs !== undefined) parts.push(`首个内容耗时 ${elapsed(record.timings.firstContentMs)}`)
    if (record.timings.firstTextMs !== undefined) parts.push(`首个正文耗时 ${elapsed(record.timings.firstTextMs)}`)
    if (parts.length) evidence.push(parts.join(' · '))
  }
  if (record.metering) {
    const {reportedInputTokens: input, reportedCachedTokens: cached, reportedOutputTokens: output, reportedCacheWriteTokens: write} = record.metering
    const counts: string[] = []
    if (input !== undefined) counts.push(`总输入 ${input.toLocaleString()}`)
    if (cached !== undefined) counts.push(`缓存读取 ${cached.toLocaleString()}`)
    if (write !== undefined) counts.push(`缓存写入 ${write.toLocaleString()}`)
    if (output !== undefined) counts.push(`输出 ${output.toLocaleString()}`)
    if (counts.length) evidence.push(`服务端原始计量：${counts.join(' / ')}`)
  }
  if (record.request) {
    const request = record.request
    evidence.push(`请求输入 ${request.inputItems} 条 · 工具 ${request.toolCount} 个`)
    const config = [request.cacheKeyPresent ? '已指定缓存路由键' : '未指定缓存路由键']
    if (request.cacheRetention) config.push(`保留策略 ${request.cacheRetention}`)
    if (request.cacheTtl) config.push(`缓存期限 ${request.cacheTtl}`)
    if (request.cacheMode) config.push(`缓存模式 ${request.cacheMode}`)
    if (request.comparisonIdPresent) config.push('已携带比较基线 ID')
    evidence.push(config.join(' · '))
  }
  if (record.disconnect) {
    const parts = [`WebSocket 中断：${disconnectCauses[record.disconnect.cause]}`]
    if (record.disconnect.closeCode !== undefined) parts.push(`关闭码 ${record.disconnect.closeCode}`)
    if (record.disconnect.lastEventType) {
      const seq = record.disconnect.lastEventSequence === undefined ? '' : ` (#${record.disconnect.lastEventSequence})`
      parts.push(`最后事件 ${record.disconnect.lastEventType}${seq}`)
    }
    evidence.push(parts.join(' · '))
  }
  if (record.server?.model) evidence.push(`服务端模型 ${record.server.model}`)
  if (record.server?.reasoningEffort) evidence.push(`服务端推理强度 ${record.server.reasoningEffort}`)
  if (record.server?.status) evidence.push(`服务端状态：${serverStatuses[record.server.status]}`)
  if (record.server?.failure) evidence.push(`服务端错误类别：${failureLabels[record.server.failure]}`)
  if (record.server?.cacheDiagnostics) {
    const diag = record.server.cacheDiagnostics
    const parts = [`服务端缓存诊断：${cacheDiagnosticStatuses[diag.status]}`]
    const reasonList = diag.reasons?.length ? diag.reasons : diag.reason ? [diag.reason] : []
    if (reasonList.length) parts.push(`原因：${reasonList.map(r => cacheDiagnosticReasons[r]).join('、')}`)
    if (diag.reusableTokens !== undefined) parts.push(`可复用 ${diag.reusableTokens.toLocaleString()}`)
    if (diag.lostTokens !== undefined) parts.push(`损失 ${diag.lostTokens.toLocaleString()}`)
    evidence.push(parts.join(' · '))
  }
  if (record.server?.responseIdHash) evidence.push(`响应标识指纹 ${record.server.responseIdHash.slice(0, 12)}`)
  let summary = meteringSummary(record)
  if (record.disconnect && record.outcome === 'failed') summary += ` · WebSocket 中断（${disconnectCauses[record.disconnect.cause]}）`
  if (record.durability?.reason === 'flush-failed') summary += ' · 会话历史保存失败'
  if (record.durability?.reason === 'history-mismatch') summary += ' · 前序历史不匹配'
  return {summary, evidence}
}

function meteringSummary(record: RequestDiagnostic): string {
  const metering = record.metering
  if (!metering && record.runtimeId) return '请求结束前未收到服务端用量'
  if (!metering) return '旧记录：未区分缓存缺失与零'
  if (metering.usage === 'missing') return '服务端未提供用量'
  if (metering.usage === 'invalid') return '服务端用量字段无效'
  if (metering.cache === 'missing') return '服务端未提供缓存计量'
  if (metering.cache === 'invalid') return '服务端缓存计量字段无效'
  if (metering.cache === 'positive') return '服务端返回缓存命中'
  const last = record.transport.at(-1)
  const prefix = record.prefix
  const stable = prefix && ['append', 'unchanged'].includes(prefix.change)
    && !prefix.instructionsChanged && !prefix.toolsChanged && !prefix.settingsChanged
  if (last?.mode === 'ws-incremental' && stable) return '连接与前缀稳定，服务端明确返回零命中'
  if (last?.connection?.state === 'new') return '服务端明确返回零命中，本次新建连接'
  return '服务端明确返回零命中'
}

function routingEvidence(record: RequestDiagnostic): string[] {
  const evidence: string[] = []
  const routing = record.routing
  if (routing) {
    if (routing.previousGapMs !== undefined) evidence.push(`距前次请求 ${elapsed(routing.previousGapMs)}`)
    if (routing.accountChanged) evidence.push('聊天账号已变化')
    if (routing.connectionChanged) evidence.push('账号连接代次已变化')
    if (routing.modelChanged) evidence.push('请求模型已变化')
    if (routing.wireSessionChanged) evidence.push('发送给服务端的会话标识已变化')
    evidence.push(`服务端会话指纹 ${routing.wireSessionHash.slice(0, 12)} · 账号连接指纹 ${routing.connectionHash.slice(0, 12)}`)
  }
  if (record.prefix?.instructionsChanged) evidence.push('系统指令指纹已变化')
  if (record.prefix?.toolsChanged) evidence.push('工具定义指纹已变化')
  if (record.prefix?.settingsChanged) evidence.push('请求设置指纹已变化')
  if (record.prefix?.change === 'changed') evidence.push('已有输入前缀已变化')
  if (record.prefix?.expectedOutputMatched === false) evidence.push('上一轮完成输出在本次回放时发生变化')
  if (record.prefix?.systemPromptSource) evidence.push(`系统提示来源：${systemPromptSourceLabels[record.prefix.systemPromptSource]}`)
  if (record.prefixSkipped) evidence.push('输入超过诊断预算，本次跳过前缀比较')
  return evidence
}

function elapsed(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`
  return `${(milliseconds / 60_000).toFixed(1)} 分钟`
}

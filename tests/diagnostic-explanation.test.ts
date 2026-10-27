import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticExplanation } from '../src/client/diagnostic-explanation.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'

const base: RequestDiagnostic = {
  id: 'fixture-request', startedAt: 1, durationMs: 2, accountKey: 'a'.repeat(64),
  model: 'fixture-model', category: 'conversation', outcome: 'completed', transport: [],
}
const prefix: NonNullable<RequestDiagnostic['prefix']> = {
  instructionsHash: 'b'.repeat(64), toolsHash: 'c'.repeat(64), settingsHash: 'd'.repeat(64), inputHash: 'e'.repeat(64),
  itemCount: 10, previousItemCount: 9, sharedItems: 9, change: 'append',
  instructionsChanged: false, toolsChanged: false, settingsChanged: false,
}

test('missing and invalid cache accounting remain distinct from an explicit zero', () => {
  assert.equal(diagnosticExplanation({...base, metering: {usage: 'reported', cache: 'missing'}}).summary, '服务端未提供缓存计量')
  assert.equal(diagnosticExplanation({...base, metering: {usage: 'reported', cache: 'invalid'}}).summary, '服务端缓存计量字段无效')
  assert.equal(diagnosticExplanation({...base, metering: {usage: 'missing', cache: 'missing'}}).summary, '服务端未提供用量')
  assert.equal(diagnosticExplanation({...base, metering: {usage: 'invalid', cache: 'invalid'}}).summary, '服务端用量字段无效')
  assert.equal(diagnosticExplanation({...base, metering: {usage: 'reported', cache: 'zero'}}).summary, '服务端明确返回零命中')
})

test('a continued request with stable prefix reports the observed zero without blaming a reconnect', () => {
  const result = diagnosticExplanation({...base, prefix,
    metering: {usage: 'reported', cache: 'zero', reportedInputTokens: 100, reportedCachedTokens: 0},
    transport: [{mode: 'ws-incremental', reason: 'continued', connection: {state: 'reused', cause: 'unknown', ageMs: 90_000}}],
  })
  assert.equal(result.summary, '连接与前缀稳定，服务端明确返回零命中')
  assert.ok(result.evidence.includes('复用已有连接 · 连接年龄 1.5 分钟'))
  assert.ok(result.evidence.includes('服务端原始计量：总输入 100 / 缓存读取 0'))
})

test('reconnection cause and identity changes are separate pieces of evidence', () => {
  const result = diagnosticExplanation({...base, runtimeId: 'fixture-runtime',
    routing: {wireSessionHash: 'f'.repeat(64), connectionHash: '1'.repeat(64), previousGapMs: 2_000,
      accountChanged: true, connectionChanged: true, modelChanged: true, wireSessionChanged: true},
    metering: {usage: 'reported', cache: 'zero'},
    transport: [{mode: 'ws-full', reason: 'cold-connection', connection: {
      state: 'new', cause: 'remote-closed', closeCode: 1000, idleMs: 1_000, ageMs: 0,
    }}],
  })
  assert.equal(result.summary, '服务端明确返回零命中，本次新建连接')
  for (const text of ['聊天账号已变化', '账号连接代次已变化', '请求模型已变化', '发送给服务端的会话标识已变化']) {
    assert.ok(result.evidence.includes(text))
  }
  assert.ok(result.evidence.some(line => line.includes('新建连接：远端关闭') && line.includes('关闭码 1000')))
})

test('legacy records do not pretend to contain original cache field presence', () => {
  const result = diagnosticExplanation({...base, inputTokens: 100, cachedTokens: 0})
  assert.equal(result.summary, '旧记录：未区分缓存缺失与零')
  assert.equal(diagnosticExplanation({...base, runtimeId: 'fixture-runtime', outcome: 'cancelled'}).summary, '请求结束前未收到服务端用量')
})

test('request controls, server outcome and budget evidence are readable without raw payloads', () => {
  const result = diagnosticExplanation({...base, prefixSkipped: 'budget-exceeded',
    metering: {usage: 'reported', cache: 'positive', reportedCacheWriteTokens: 25},
    request: {inputItems: 20, toolCount: 3, cacheKeyPresent: true, cacheRetention: '24h', cacheTtl: '12h'},
    server: {model: 'fixture-server-model', status: 'incomplete', failure: 'context-limit', responseIdHash: 'a'.repeat(64)},
  })
  assert.equal(result.summary, '服务端返回缓存命中')
  assert.ok(result.evidence.includes('输入超过诊断预算，本次跳过前缀比较'))
  assert.ok(result.evidence.includes('请求输入 20 条 · 工具 3 个'))
  assert.ok(result.evidence.includes('已指定缓存路由键 · 保留策略 24h · 缓存期限 12h'))
  assert.ok(result.evidence.includes('服务端状态：未完成'))
  assert.ok(result.evidence.includes('服务端错误类别：上下文限制'))
  assert.ok(result.evidence.includes('响应标识指纹 aaaaaaaaaaaa'))
})

test('failed history confirmation stays visible beside the reported cache outcome', () => {
  const failure = diagnosticExplanation({...base, metering: {usage: 'reported', cache: 'zero'},
    durability: {reason: 'flush-failed', candidates: 2, confirmed: 0}})
  assert.equal(failure.summary, '服务端明确返回零命中 · 会话历史保存失败')
  assert.ok(failure.evidence.includes('持久化确认：会话历史保存失败 · 候选 2 个 / 确认 0 个'))
  const mismatch = diagnosticExplanation({...base, metering: {usage: 'reported', cache: 'positive'},
    durability: {reason: 'history-mismatch', candidates: 2, confirmed: 1}})
  assert.equal(mismatch.summary, '服务端返回缓存命中 · 前序历史不匹配')
})

test('socket disconnect evidence renders cause, close code and last event sequence', () => {
  const interrupted = diagnosticExplanation({...base, runtimeId: 'fixture-runtime', outcome: 'failed',
    disconnect: {cause: 'remote-closed', closeCode: 1006, lastEventType: 'response.output_text.delta', lastEventSequence: 2}})
  assert.equal(interrupted.summary, '请求结束前未收到服务端用量 · WebSocket 中断（远端关闭）')
  assert.ok(interrupted.evidence.includes('WebSocket 中断：远端关闭 · 关闭码 1006 · 最后事件 response.output_text.delta (#2)'))
})

test('explanation renders rotation/health causes, server cache diagnostics, replay retention, timings and expected output mismatch', () => {
  const explained = diagnosticExplanation({
    ...base,
    runtimeId: 'fixture-runtime',
    outcome: 'failed',
    prefix: {...prefix, expectedOutputMatched: false, systemPromptSource: 'in-history'},
    replay: {totalBlocks: 5, nativeBlocks: 4, degradedBlocks: 1, reasons: ['edited', 'reordered']},
    timings: {firstContentMs: 1200, firstTextMs: 2500},
    metering: {usage: 'reported', cache: 'zero', reportedInputTokens: 200, reportedCachedTokens: 0},
    server: {
      reasoningEffort: 'high',
      cacheDiagnostics: {
        status: 'cache_miss',
        reason: 'reasoning_effort',
        reasons: ['reasoning_effort', 'format', 'ttl_expired', 'cache_evicted'],
        reusableTokens: 150,
        lostTokens: 50,
      },
    },
    transport: [{
      mode: 'ws-full',
      reason: 'planned-rotation',
      connection: {state: 'new', cause: 'planned-rotation', ageMs: 3_000_000, socketGeneration: 3},
    }],
    disconnect: {cause: 'health-check-failed'},
  })
  assert.ok(explained.summary.includes('WebSocket 中断（连接探活失败）'))
  assert.ok(explained.evidence.includes('上一轮完成输出在本次回放时发生变化'))
  assert.ok(explained.evidence.includes('系统提示来源：历史内开发者消息'))
  assert.ok(explained.evidence.includes('新建连接：连接寿命主动轮换 · 连接年龄 50.0 分钟 · 连接代次 #3'))
  assert.ok(explained.evidence.includes('原生回放保留：4 / 5 块（降级 1 块） · 原因：内容已编辑、顺序已调整'))
  assert.ok(explained.evidence.includes('首个内容耗时 1.2 秒 · 首个正文耗时 2.5 秒'))
  assert.ok(explained.evidence.includes('服务端推理强度 high'))
  assert.ok(explained.evidence.includes('服务端缓存诊断：未命中 · 原因：推理强度变更、输出格式变更、缓存期限到期、缓存已淘汰 · 可复用 150 · 损失 50'))
})

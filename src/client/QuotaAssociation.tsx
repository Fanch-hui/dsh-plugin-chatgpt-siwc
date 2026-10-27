import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaLinkSetting, SiwcStatus } from '../api/types.js'
import type { SiwcController } from './controller.js'

export function QuotaAssociation({controller, status, busy}: {controller: SiwcController; status: SiwcStatus; busy: boolean}) {
  const codex = status.quota?.codex
  const accountId = status.activeAccountId
  const sourceKey = codex?.sourceKey
  const [confirmation, setConfirmation] = useState<QuotaLinkSetting>()
  useEffect(() => { setConfirmation(undefined) }, [accountId, sourceKey])
  if (!accountId || !status.authenticated || !sourceKey || !codex?.snapshot) return null
  const account = status.accounts.find(value => value.id === accountId)
  if (codex.linkedToCurrent) return <div style={{display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap'}}>
    <span style={{fontSize: 12}}>已关联当前聊天账号，会话中可查看额度。</span>
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void controller.run('unlinkCodexQuota', accountId) }}>解除关联</Button>
  </div>
  return <div style={{display: 'grid', gap: 10}}>
    <div><Button size="sm" variant="outline" disabled={busy || codex.state !== 'ready'}
      onClick={() => { setConfirmation({accountId, sourceKey}) }}>关联到当前聊天账号</Button></div>
    {confirmation && <div role="group" aria-label="确认额度账号关联" style={{display: 'grid', gap: 8, fontSize: 12}}>
      <div style={{overflowWrap: 'anywhere'}}>聊天账号：{account?.email ?? '当前账号'}</div>
      <div style={{overflowWrap: 'anywhere'}}>额度账号：{codex.email ?? '当前 Codex 登录'}{codex.planType ? ` · ${codex.planType}` : ''}</div>
      <p style={{margin: 0}}>请确认两个登录属于同一 ChatGPT 账号和工作区。确认后，会话标识使用此连接的额度。</p>
      {!codex.persistentLink && <p style={{margin: 0}}>此 Codex 版本未提供稳定账号标识，重启后需要重新确认关联。</p>}
      <div style={{display: 'flex', gap: 8}}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setConfirmation(undefined) }}>取消</Button>
        <Button size="sm" disabled={busy || confirmation.accountId !== accountId || confirmation.sourceKey !== sourceKey}
          onClick={() => { void controller.run('linkCodexQuota', confirmation).then(() => { setConfirmation(undefined) }) }}>确认关联</Button>
      </div>
    </div>}
  </div>
}

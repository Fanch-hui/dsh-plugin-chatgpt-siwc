import { DiagnosticsStore } from './diagnostics/store.js'
import type { DiagnosticsFilter } from './diagnostics/types.js'
import type { CacheSettings, ContextWindowSetting, QuotaLinkSetting } from './api/types.js'
import { QuotaService } from './quota/service.js'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { SiwcAuth } from './auth/index.js'
import { Controller } from './api/controller.js'
import { ConnectionStore } from './storage/state.js'
import { TYPERT } from './remote.js'
import { confirmedResponses } from './provider/durability.js'

declare module '@deepseek-ai/cordis' {
  interface Context { chatgptSiwc: ChatGPTSiwc }
}

export default class ChatGPTSiwc extends TypertRemoteService {
  static inject = ['llm', 'credentials', 'typert', 'sessions', 'attachments', 'profileContext']
  private readonly controller: Controller
  constructor(ctx: Context) {
    super(ctx, 'chatgptSiwc')
    const auth = new SiwcAuth()
    const store = new ConnectionStore(ctx.credentials, ctx.profileContext.dir, auth)
    this.controller = new Controller(store, id => ctx.sessions.get(SessionId(id))?.header,
      async (block, signal) => {
        const image = await ctx.attachments.readImage(block.attachment, signal)
        return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
      }, auth, undefined, ref => resolveImageAttachmentAccess(ctx.attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref), {
        sessionScope: ctx.profileContext.dir,
        confirmedResponses: (options, context, observe) => confirmedResponses(ctx.sessions, options, context, observe),
      }, new QuotaService(store, ctx.profileContext.dir), new DiagnosticsStore(ctx.profileContext.dir))
    ctx.typert.register(TYPERT)
    ctx.llm.registerAdapter(['chatgpt-siwc'], this.controller.adapter)
    ctx.effect(() => () => this.controller.dispose())
  }
  linkCodexQuota(setting: QuotaLinkSetting) { return this.controller.linkCodexQuota(setting) }
  unlinkCodexQuota(accountId: string) { return this.controller.unlinkCodexQuota(accountId) }
  refreshQuota() { return this.controller.refreshQuota() }
  connectCodexQuota() { return this.controller.connectCodexQuota() }
  cancelCodexQuota() { return this.controller.cancelCodexQuota() }
  disconnectCodexQuota() { return this.controller.disconnectCodexQuota() }
  addCodexQuota() { return this.controller.addCodexQuota() }
  selectCodexQuota(id: string) { return this.controller.selectCodexQuota(id) }
  removeCodexQuota(id: string) { return this.controller.removeCodexQuota(id) }
  setContextWindow(setting: ContextWindowSetting) { return this.controller.setContextWindow(setting) }
  setCacheSettings(settings: CacheSettings) { return this.controller.setCacheSettings(settings) }
  queryDiagnostics(filter: DiagnosticsFilter) { return this.controller.queryDiagnostics(filter) }
  status() { return this.controller.status() }
  addAccount() { return this.controller.addAccount() }
  switchAccount(accountId: string) { return this.controller.switchAccount(accountId) }
  removeAccount(accountId: string) { return this.controller.removeAccount(accountId) }
  reauthorizeAccount(accountId: string) { return this.controller.reauthorizeAccount(accountId) }
  beginSignIn() { return this.controller.beginSignIn() }
  cancelSignIn() { return this.controller.cancelSignIn() }
  signOut() { return this.controller.signOut() }
  refreshModels() { return this.controller.refreshModels() }
  probeModel(modelId: string) { return this.controller.probeModel(modelId) }
  authorizeSession(sessionId: string) { return this.controller.authorizeSession(sessionId) }
  revokeSession(sessionId: string) { return this.controller.revokeSession(sessionId) }
  setBackgroundAllowed(allowed: boolean) { return this.controller.setBackgroundAllowed(allowed) }
}

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { contribution } from '../remote.js'
import { SiwcController, type RemoteFace } from './controller.js'
import { Settings } from './Settings.js'
import { QuotaIndicator } from './QuotaIndicator.js'

export const inject = ['slots', 'remote']

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  await ctx.inject(['remote.chatgptSiwc'], ctx => {
    const controller = new SiwcController((ctx.remote as unknown as { chatgptSiwc: RemoteFace }).chatgptSiwc)
    ctx.effect(() => () => controller.dispose())
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: 'dsh-plugin-chatgpt-siwc',
    }, () => <Settings controller={controller} />))
    ctx.inject(['modelDirectories'], ctx => {
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'chatgpt-siwc-quota',
        inject: sessionId => ({directory: ctx.modelDirectories.directoryFor(sessionId as SessionId).store}),
      }, ({directory}) => <QuotaIndicator controller={controller} directory={directory} />))
    })
    void controller.run('status')
  })
}

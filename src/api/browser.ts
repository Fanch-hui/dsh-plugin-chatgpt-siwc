import { execFile } from 'node:child_process'

export async function openSignIn(url: string): Promise<void> {
  const target = new URL(url)
  if (target.origin !== 'https://auth.openai.com' || target.pathname !== '/api/accounts/authorize') {
    throw new Error('登录地址无效。')
  }
  await openBrowser(url)
}

export async function openCodexSignIn(url: string): Promise<void> {
  const target = new URL(url)
  if (!['https://auth.openai.com', 'https://chatgpt.com'].includes(target.origin) || target.username || target.password) {
    throw new Error('Codex 登录地址无效。')
  }
  await openBrowser(url)
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, error => {
      if (error) reject(new Error('系统浏览器未能打开，请检查默认浏览器后重试。'))
      else resolve()
    })
  })
}

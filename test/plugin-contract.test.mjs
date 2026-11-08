/**
 * Plugin-row contract test: the bundle exposes a Cordis plugin whose apply()
 * starts the bridge for the row's lifetime, survives a second row on the same
 * port, and stops the listener on dispose.
 */

import { apply, name } from '../index.js'

const logs = []
const disposers = []
const ctx = {
  logger: {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  },
  effect: (fn, label) => {
    disposers.push([label, fn()])
  },
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label)
    return
  }
  failures += 1
  console.log('  FAIL  ' + label + (detail === undefined ? '' : ' :: ' + detail))
}

const health = () => fetch('http://127.0.0.1:18096/health', { signal: AbortSignal.timeout(1000) })
  .then((response) => response.json())
  .catch(() => undefined)

check('plugin 有名字', name === 'unity-mcp-bridge', name)
apply(ctx, { port: 18096, upstreamUrl: 'http://127.0.0.1:8080/mcp' })
apply(ctx, { port: 18096, upstreamUrl: 'http://127.0.0.1:8080/mcp' })
await new Promise((resolve) => setTimeout(resolve, 1500))

const status = await health()
check('桥接已监听', status?.service === 'dsh-unity-mcp-bridge', JSON.stringify(status))
check('第二个实例选择复用', logs.some(([, message]) => message.includes('复用')), JSON.stringify(logs))
check('effect 标签已登记', disposers.every(([label]) => label === 'unity-mcp-bridge.server'), disposers[0]?.[0])

for (const [, dispose] of disposers) dispose()
await new Promise((resolve) => setTimeout(resolve, 400))
check('dispose 后端口已释放', (await health()) === undefined)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exitCode = failures === 0 ? 0 : 1

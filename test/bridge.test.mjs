/**
 * Bridge self-test.
 *
 * Four scenarios, all runnable without touching the editor:
 *
 * A. Real Unity server. Connect through the bridge, delete the bridge's
 *    upstream session on the server (exactly what an editor restart does),
 *    and prove the next tool call still succeeds on the same downstream
 *    session.
 * B. Fake upstream. Prove a client connects while the server is down, that the
 *    tool list arrives later with a tools/list_changed notification, and that
 *    a call while the server is away fails with a readable error instead of
 *    hanging.
 * C. Two Hosts on one port: the second reuses the running bridge and takes
 *    the port over when the first exits.
 * D. Tool groups: only enabled groups are injected, activation adds its tools
 *    with one notification, and a toggle that changes nothing stays silent.
 */

import http from 'node:http'
import { createBridge } from '../bridge.js'

const REAL_MCP = 'http://127.0.0.1:8080/mcp'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + name)
    return
  }
  failures += 1
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' :: ' + detail))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Order-sensitive comparison for tool-name lists. */
function sameNames(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((name, index) => name === expected[index])
}

/** Minimal MCP client over streamable HTTP, as a browser-less caller sees it. */
class TestClient {
  constructor(url) {
    this.url = url
    this.sessionId = undefined
    this.events = []
    this.nextId = 1
    this.abort = new AbortController()
  }

  async post(message) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId
    const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message) })
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId !== null) this.sessionId = sessionId
    const text = await response.text()
    const kind = response.headers.get('content-type') ?? ''
    if (kind.includes('event-stream')) {
      const data = text.split('\n\n')
        .map((block) => block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
        .filter((value) => value !== '')
      return data.map((value) => JSON.parse(value))
    }
    return text.trim() === '' ? [] : [JSON.parse(text)]
  }

  async initialize() {
    const messages = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } },
    })
    const reply = messages.find((message) => message.id !== undefined)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return reply?.result
  }

  async request(method, params) {
    const messages = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params })
    return messages.find((message) => message.id !== undefined || message.error !== undefined)
  }

  async listen() {
    const response = await fetch(this.url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': this.sessionId },
      signal: this.abort.signal,
    })
    void (async () => {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (;;) {
            const index = buffer.indexOf('\n\n')
            if (index === -1) break
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
            if (data !== '') this.events.push(JSON.parse(data))
          }
        }
      } catch {
        // Aborted by close().
      }
    })()
  }

  close() {
    this.abort.abort()
  }
}

/** Fake MCP server that can be restarted and whose sessions can be invalidated. */
function createFakeUpstream(port) {
  const state = { server: null, sessions: new Set(), tools: undefined, subscribers: new Set(), groups: undefined }
  const handlers = new Map()
  state.emit = (message) => {
    const frame = 'event: message\ndata: ' + JSON.stringify(message) + '\n\n'
    for (const subscriber of state.subscribers) {
      try {
        subscriber.write(frame)
      } catch {
        state.subscribers.delete(subscriber)
      }
    }
  }
  state.listChanged = () => state.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  /** Answer one manage_tools call the way MCP for Unity does. */
  state.handleManageTools = (args) => {
    const action = args?.action
    if (action === 'activate' || action === 'deactivate') {
      const group = state.groups.find((entry) => entry.name === args?.group)
      if (group !== undefined) group.enabled = action === 'activate'
      const payload = { [action === 'activate' ? 'activated' : 'deactivated']: args?.group }
      // The real server announces the change before it answers the call.
      state.listChanged()
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
    }
    const payload = { groups: state.groups }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
  }
  handlers.set('initialize', (_params, context) => {
    const sessionId = 'fake-' + Math.random().toString(16).slice(2)
    state.sessions.add(sessionId)
    context.sessionId = sessionId
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fake-unity', version: '0.0.0' },
      instructions: 'fake instructions',
    }
  })
  state.handlers = handlers
  state.serve = async () => {
    const server = http.createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': fake\n\n')
        state.subscribers.add(response)
        response.on('close', () => state.subscribers.delete(response))
        return
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (message.method === 'notifications/initialized') {
        response.writeHead(202, { 'content-length': 0 }).end()
        return
      }
      const sessionId = request.headers['mcp-session-id']
      if (message.method !== 'initialize' && !state.sessions.has(sessionId)) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 'server-error', error: { code: -32600, message: 'Session not found' } })
        response.writeHead(404, { 'content-type': 'application/json' }).end(body)
        return
      }
      const context = {}
      let result
      if (message.method === 'tools/list') {
        result = { tools: state.tools ?? [] }
      } else if (message.method === 'tools/call' && message.params?.name === 'manage_tools' && Array.isArray(state.groups)) {
        result = state.handleManageTools(message.params.arguments)
      } else if (message.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'fake:' + message.params.name }], isError: false }
      } else if (message.method === 'ping') {
        result = {}
      } else {
        result = handlers.get(message.method)?.(message.params, context) ?? {}
      }
      const headers = { 'content-type': 'application/json' }
      if (context.sessionId !== undefined) headers['mcp-session-id'] = context.sessionId
      response.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    state.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  }
  state.stop = async () => {
    if (state.server === null) return
    state.sessions.clear()
    for (const subscriber of state.subscribers) subscriber.end()
    state.subscribers.clear()
    const server = state.server
    state.server = null
    await new Promise((resolve) => server.close(resolve))
  }
  state.invalidateSessions = () => state.sessions.clear()
  state.setTools = (tools) => {
    state.tools = tools
    state.listChanged()
  }
  return state
}

async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}

async function healthOf(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1000) })
    return await response.json()
  } catch {
    return undefined
  }
}

async function scenarioRealUnity() {
  console.log('\nA. 真实 Unity 服务器：编辑器重启后工具调用仍可用')
  const probe = await fetch(REAL_MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }) })
    .then((response) => response.ok).catch(() => false)
  if (!probe) {
    console.log('  SKIP  8080 上没有 Unity MCP 服务器，跳过真实服务器场景')
    return
  }
  const bridge = createBridge({ port: 18099, upstreamUrl: REAL_MCP, pollUpMs: 500, pollDownMs: 300, idlePollMs: 300, keepaliveMs: 1000, log: (level, message) => {
    if (level !== 'info') console.log('        [bridge:' + level + '] ' + message)
  } })
  await bridge.start()
  try {
    const client = new TestClient('http://127.0.0.1:18099/mcp')
    const init = await client.initialize()
    check('initialize 返回 Unity 服务器信息', init?.serverInfo?.name === 'mcp-for-unity-server', JSON.stringify(init?.serverInfo))
    const downstreamSession = client.sessionId
    check('下游会话 id 已下发', typeof downstreamSession === 'string' && downstreamSession.length > 0)
    await client.listen()
    const list = await client.request('tools/list')
    const tools = list?.result?.tools ?? []
    check('tools/list 返回 Unity 工具', tools.length > 20, String(tools.length))

    const target = tools.find((tool) => tool.name === 'find_gameobjects') ?? tools.find((tool) => tool.name === 'manage_scene')
    check('找到可用的只读工具', target !== undefined, target?.name)

    const callTool = async () => client.request('tools/call', {
      name: target?.name ?? 'find_gameobjects',
      arguments: target?.name === 'manage_scene'
        ? { action: 'get_hierarchy' }
        : { search_term: 'UnityBridgeSelfTest', search_method: 'by_name' },
    })
    const call = target === undefined ? undefined : await callTool()
    check('重启前工具调用成功', call?.result !== undefined && call?.error === undefined, JSON.stringify(call?.error))

    const before = await healthOf(18099)
    check('桥接已连接上游', before?.upstream?.connected === true, JSON.stringify(before?.upstream))
    check('上游会话 id 存在', typeof before?.upstream?.sessionId === 'string')

    // Exactly what an editor restart does: every session id stops existing.
    const killed = await fetch(REAL_MCP, { method: 'DELETE', headers: { 'mcp-session-id': before.upstream.sessionId } })
    check('上游会话已从服务器删除（模拟编辑器重启）', killed.status === 200, String(killed.status))

    const stale = await fetch(REAL_MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': before.upstream.sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    check('旧会话现在返回 Session not found', stale.status === 404, String(stale.status))

    const after = target === undefined ? undefined : await callTool()
    check('重启后同一个下游会话的调用成功', after?.result !== undefined && after?.error === undefined, JSON.stringify(after?.error))
    check('下游会话 id 没有变化', client.sessionId === downstreamSession)

    const recovered = await healthOf(18099)
    check('上游自动重建了新会话', recovered?.upstream?.connected === true
      && recovered?.upstream?.sessionId !== before?.upstream?.sessionId,
    JSON.stringify({ before: before?.upstream?.sessionId, after: recovered?.upstream?.sessionId }))
    client.close()
  } finally {
    bridge.stop()
  }
}

async function scenarioFakeUpstream() {
  console.log('\nB. 服务器离线 → 上线 → 重启：连接、工具列表与错误语义')
  const fake = createFakeUpstream(18098)
  const bridge = createBridge({
    port: 18097,
    upstreamUrl: 'http://127.0.0.1:18098/mcp',
    pollUpMs: 400,
    pollDownMs: 300,
    idlePollMs: 200,
    connectWaitMs: 200,
    listWaitMs: 200,
    callWaitMs: 800,
    recoverWaitMs: 400,
    keepaliveMs: 500,
    log: (level, message) => {
      if (level !== 'info') console.log('        [bridge:' + level + '] ' + message)
    },
  })
  await bridge.start()
  try {
    const client = new TestClient('http://127.0.0.1:18097/mcp')
    const started = Date.now()
    const init = await client.initialize()
    const elapsed = Date.now() - started
    check('上游离线时 initialize 仍然成功', init !== undefined, JSON.stringify(init))
    check('离线 initialize 不阻塞（< 3s）', elapsed < 3000, elapsed + 'ms')
    await client.listen()

    const empty = await client.request('tools/list')
    check('上游离线时 tools/list 返回空列表', Array.isArray(empty?.result?.tools) && empty.result.tools.length === 0)

    const offlineCall = await client.request('tools/call', { name: 'anything', arguments: {} })
    check('上游离线时调用返回可读错误', typeof offlineCall?.error?.message === 'string'
      && offlineCall.error.message.includes('Unity'), JSON.stringify(offlineCall?.error))

    fake.setTools([
      { name: 'fake_tool', description: 'fake', inputSchema: { type: 'object' } },
    ])
    await fake.serve()
    const sawChange = await waitFor(() => client.events.some((event) => event.method === 'notifications/tools/list_changed'), 6000)
    check('上游上线后广播 tools/list_changed', sawChange, JSON.stringify(client.events))

    const online = await client.request('tools/call', { name: 'fake_tool', arguments: {} })
    check('上游上线后调用成功', online?.result?.content?.[0]?.text === 'fake:fake_tool', JSON.stringify(online))

    fake.invalidateSessions()
    fake.setTools([
      { name: 'fake_tool', description: 'fake', inputSchema: { type: 'object' } },
      { name: 'fake_tool_2', description: 'fake 2', inputSchema: { type: 'object' } },
    ])
    const afterRestart = await client.request('tools/call', { name: 'fake_tool', arguments: {} })
    check('上游会话失效后调用被透明重试', afterRestart?.result?.content?.[0]?.text === 'fake:fake_tool', JSON.stringify(afterRestart))

    await fake.stop()
    const down = await client.request('tools/call', { name: 'fake_tool', arguments: {} })
    check('上游下线后调用返回可读错误', typeof down?.error?.message === 'string', JSON.stringify(down))
    const cachedList = await client.request('tools/list')
    check('上游下线后 tools/list 退回缓存', (cachedList?.result?.tools ?? []).length === 2, JSON.stringify(cachedList?.result?.tools?.length))
    client.close()
  } finally {
    bridge.stop()
    await fake.stop()
  }
}

async function scenarioGroups() {
  console.log('\nD. 工具分组：只注入已启用组的工具，激活后才出现，空转不广播')
  const fake = createFakeUpstream(18096)
  fake.groups = [
    { name: 'core', enabled: true },
    { name: 'docs', enabled: false },
    { name: 'vfx', enabled: false },
  ]
  fake.tools = [
    { name: 'manage_tools', description: 'meta', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: [] } } },
    { name: 'set_active_instance', description: 'meta', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: [] } } },
    { name: 'manage_scene', description: 'core', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: ['group:core'] } } },
    { name: 'unity_docs', description: 'docs', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: ['group:docs'] } } },
    { name: 'manage_vfx', description: 'vfx', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: ['group:vfx'] } } },
  ]
  const settings = {
    upstreamUrl: 'http://127.0.0.1:18096/mcp',
    pollUpMs: 400,
    pollDownMs: 300,
    idlePollMs: 250,
    groupStateMs: 300,
    syncSettleMs: 1000,
    keepaliveMs: 500,
    log: (level, message) => {
      if (level === 'error') console.log('        [bridge:error] ' + message)
    },
  }
  await fake.serve()
  const bridge = createBridge({ ...settings, port: 18095 })
  const unfiltered = createBridge({ ...settings, port: 18094, groupFilter: false })
  await bridge.start()
  await unfiltered.start()
  try {
    const client = new TestClient('http://127.0.0.1:18095/mcp')
    await client.initialize()
    await client.listen()
    const names = async () => ((await client.request('tools/list'))?.result?.tools ?? []).map((tool) => tool.name)

    const initial = await names()
    check('默认只注入已启用组与无分组工具', sameNames(initial, ['manage_tools', 'set_active_instance', 'manage_scene']), JSON.stringify(initial))
    const health = await healthOf(18095)
    check('健康检查报告可见数与启用组', health?.upstream?.visible === 3 && health?.upstream?.tools === 5
      && JSON.stringify(health?.upstream?.groups) === '["core"]', JSON.stringify(health?.upstream))

    const before = client.events.length
    const activated = await client.request('tools/call', { name: 'manage_tools', arguments: { action: 'activate', group: 'docs' } })
    check('manage_tools 调用成功', activated?.result !== undefined && activated?.error === undefined, JSON.stringify(activated?.error))
    const sawChange = await waitFor(() => client.events.slice(before).some((event) => event.method === 'notifications/tools/list_changed'), 5000)
    check('激活组后广播一次 tools/list_changed', sawChange, JSON.stringify(client.events.slice(before)))
    const grown = await names()
    check('激活后新增组的工具可注入', sameNames(grown, ['manage_tools', 'set_active_instance', 'manage_scene', 'unity_docs']), JSON.stringify(grown))

    const quiet = client.events.length
    await client.request('tools/call', { name: 'manage_tools', arguments: { action: 'activate', group: 'core' } })
    await sleep(800)
    check('可见集合没变时不向模型侧广播', client.events.slice(quiet).every((event) => event.method !== 'notifications/tools/list_changed'), JSON.stringify(client.events.slice(quiet)))

    await client.request('tools/call', { name: 'manage_tools', arguments: { action: 'deactivate', group: 'core' } })
    const shrunk = await waitFor(async () => sameNames(await names(), ['manage_tools', 'set_active_instance', 'unity_docs']), 5000, 150)
    check('停用组后其工具不再注入', shrunk, JSON.stringify(await names()))

    const plain = new TestClient('http://127.0.0.1:18094/mcp')
    await plain.initialize()
    const all = ((await plain.request('tools/list'))?.result?.tools ?? []).map((tool) => tool.name)
    check('groupFilter: false 时仍然全部注入', all.length === 5, JSON.stringify(all))
    plain.close()

    // A custom tool set added at runtime must not need a bridge restart, and a
    // group tag the group manager does not know yet must never hide a tool.
    fake.setTools([
      ...fake.tools,
      { name: 'custom_plain', description: 'custom', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: [] } } },
      { name: 'custom_no_meta', description: 'custom', inputSchema: { type: 'object' } },
      { name: 'custom_unknown_group', description: 'custom', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: ['group:my_custom_set'] } } },
      { name: 'custom_disabled_group', description: 'custom', inputSchema: { type: 'object' }, _meta: { fastmcp: { tags: ['group:vfx'] } } },
    ])
    const appeared = await waitFor(async () => (await names()).includes('custom_plain'), 5000, 150)
    const custom = await names()
    check('运行时新增的工具无需重启即注入', appeared, JSON.stringify(custom))
    check('无分组标签的自定义工具可见', custom.includes('custom_no_meta'), JSON.stringify(custom))
    check('未知分组标签按可见处理（自定义工具集）', custom.includes('custom_unknown_group'), JSON.stringify(custom))
    check('已知且未启用分组的自定义工具仍然隐藏', !custom.includes('custom_disabled_group'), JSON.stringify(custom))
    check('manage_tools 始终保留', custom.includes('manage_tools'), JSON.stringify(custom))
    client.close()
  } finally {
    bridge.stop()
    unfiltered.stop()
    await fake.stop()
  }
}

async function scenarioTakeover() {
  console.log('\nC. 两个 Host：复用已在运行的桥接，前一个退出后接管端口')
  const base = { port: 18092, upstreamUrl: REAL_MCP, idlePollMs: 400, pollDownMs: 300 }
  const first = createBridge({ ...base, log: () => {} })
  const second = createBridge({ ...base, log: () => {} })
  await first.start()
  await sleep(150)
  const secondOutcome = await second.start()
  check('第二个 Host 选择复用', secondOutcome.state === 'external', secondOutcome)
  check('复用时端点仍可用', (await healthOf(18092))?.service === 'dsh-unity-mcp-bridge')

  first.stop()
  await sleep(200)
  check('第一个 Host 退出后端点消失', (await healthOf(18092)) === undefined)
  const tookOver = await waitFor(async () => (await healthOf(18092))?.service === 'dsh-unity-mcp-bridge', 8000, 250)
  check('第二个 Host 接管端口', tookOver)
  second.stop()
  await sleep(200)
  check('第二个 Host 退出后端点释放', (await healthOf(18092)) === undefined)
}

await scenarioRealUnity()
await scenarioFakeUpstream()
await scenarioGroups()
await scenarioTakeover()
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exitCode = failures === 0 ? 0 : 1

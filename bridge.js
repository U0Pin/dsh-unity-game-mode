/**
 * Streamable-HTTP MCP bridge between DSH and the Unity Editor's MCP server.
 *
 * Why this exists. The Unity server (MCP for Unity) is a Python process that
 * lives and dies with the editor. Every editor restart therefore destroys every
 * MCP session: a request carrying a session id from before the restart answers
 * 404 {"code": -32600, "message": "Session not found"}. The DSH MCP client
 * cannot recover from that on its own - a streamable-HTTP transport never
 * reports onclose for a dead session, so the client keeps believing it is
 * connected, keeps its tools registered, and every call fails until the
 * conversation is reopened.
 *
 * The bridge owns the upstream session instead, and presents a server that
 * never goes away:
 *
 * - initialize always answers immediately (real server info when the editor is
 *   up, last known or synthetic when it is not), so a DSH session started
 *   before the editor never loses its tool registration.
 * - Requests are forwarded; a session that died underneath is re-established
 *   and the request is re-issued once. That is safe precisely because such a
 *   failure means the server rejected the request before running it.
 * - tools/list falls back to the last known list while the editor is away, and
 *   a supervisor re-reads it once the editor returns, broadcasting
 *   notifications/tools/list_changed so the DSH client re-syncs.
 * - Only tools of enabled groups are published: Unity lists every tool no
 *   matter which groups are on, and it does not refuse calls to a disabled
 *   group, so this injection point is the whole progressive-disclosure
 *   mechanism. Group state comes from `manage_tools` list_groups and each
 *   tool's `_meta.fastmcp.tags`; ungrouped meta tools stay visible, and an
 *   unreadable state exposes everything rather than locking the agent out.
 * - A list change is announced only when the published subset really moved:
 *   forwarding Unity's unconditional notification makes the client recreate
 *   every tool definition, which retires the tool admission of the running
 *   step and surfaces as an "unknown tool" failure on the next call.
 * - The supervisor also polls while a session sits idle, which keeps the
 *   upstream session alive past the server's 30 minute idle timeout.
 */

import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Health-endpoint marker used to recognize another instance of this bridge. */
export const BRIDGE_SERVICE = 'dsh-unity-mcp-bridge'

/** Defaults shared by the plugin row and standalone use. */
const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 18080,
  upstreamUrl: 'http://127.0.0.1:8080/mcp',
  protocolVersion: '2025-06-18',
  connectWaitMs: 1200,
  listWaitMs: 1200,
  callWaitMs: 15000,
  recoverWaitMs: 10000,
  requestTimeoutMs: 110000,
  pollUpMs: 15000,
  pollDownMs: 3000,
  idlePollMs: 10000,
  keepaliveMs: 20000,
  clientIdleMs: 6 * 60 * 60 * 1000,
  maxBodyBytes: 16 * 1024 * 1024,
  groupFilter: true,
  groupStateMs: 15000,
  syncSettleMs: 5000,
  stateFile: '',
})

/** A failure with a stable code, so callers can distinguish retryable states. */
class BridgeError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'BridgeError'
    this.code = code
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function truncate(text, limit = 400) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(0, limit) + '...'
}

/** Numeric options accept anything finite and positive; everything else clamps. */
function numberOption(value, fallback, min, max) {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Normalize the row config into a complete option set.
 *
 * @param options - Raw plugin config or CLI flags.
 * @returns Frozen bridge options.
 */
export function resolveConfig(options = {}) {
  const source = options && typeof options === 'object' ? options : {}
  const url = typeof source.upstreamUrl === 'string' && source.upstreamUrl.trim() !== ''
    ? source.upstreamUrl.trim()
    : DEFAULTS.upstreamUrl
  const host = typeof source.host === 'string' && source.host.trim() !== '' ? source.host.trim() : DEFAULTS.host
  return Object.freeze({
    host,
    port: Math.trunc(numberOption(source.port, DEFAULTS.port, 1, 65535)),
    upstreamUrl: url,
    protocolVersion: typeof source.protocolVersion === 'string' && source.protocolVersion !== ''
      ? source.protocolVersion
      : DEFAULTS.protocolVersion,
    clientName: typeof source.clientName === 'string' && source.clientName !== '' ? source.clientName : 'dsh-unity-mcp-bridge',
    clientVersion: typeof source.clientVersion === 'string' && source.clientVersion !== '' ? source.clientVersion : '1.0.0',
    connectWaitMs: numberOption(source.connectWaitMs, DEFAULTS.connectWaitMs, 0, 60000),
    listWaitMs: numberOption(source.listWaitMs, DEFAULTS.listWaitMs, 0, 60000),
    callWaitMs: numberOption(source.callWaitMs, DEFAULTS.callWaitMs, 0, 300000),
    recoverWaitMs: numberOption(source.recoverWaitMs, DEFAULTS.recoverWaitMs, 0, 300000),
    requestTimeoutMs: numberOption(source.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 600000),
    pollUpMs: numberOption(source.pollUpMs, DEFAULTS.pollUpMs, 1000, 600000),
    pollDownMs: numberOption(source.pollDownMs, DEFAULTS.pollDownMs, 250, 600000),
    idlePollMs: numberOption(source.idlePollMs, DEFAULTS.idlePollMs, 1000, 600000),
    keepaliveMs: numberOption(source.keepaliveMs, DEFAULTS.keepaliveMs, 1000, 300000),
    clientIdleMs: numberOption(source.clientIdleMs, DEFAULTS.clientIdleMs, 60000, 7 * 24 * 60 * 60 * 1000),
    maxBodyBytes: numberOption(source.maxBodyBytes, DEFAULTS.maxBodyBytes, 1024, 256 * 1024 * 1024),
    groupFilter: source.groupFilter !== false,
    groupStateMs: numberOption(source.groupStateMs, DEFAULTS.groupStateMs, 1000, 600000),
    syncSettleMs: numberOption(source.syncSettleMs, DEFAULTS.syncSettleMs, 0, 60000),
    stateFile: typeof source.stateFile === 'string' ? source.stateFile : DEFAULTS.stateFile,
  })
}

/** Whether a fetch failure means the request certainly never reached the server. */
function isConnectionLost(error) {
  const code = error?.cause?.code ?? error?.code
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE'
    || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'UND_ERR_SOCKET'
}

/** Whether a fetch failure was our own deadline rather than a server answer. */
function isDeadline(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'UND_ERR_HEADERS_TIMEOUT'
}

/** Combine the caller's cancellation with the operation deadline. */
function combineSignals(signals) {
  const live = signals.filter((signal) => signal !== undefined)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live)
  const controller = new AbortController()
  const abort = () => controller.abort(live.find((signal) => signal.aborted)?.reason)
  for (const signal of live) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/** Decode a JSON-RPC payload carried either as JSON or as an SSE event stream. */
function extractMessages(contentType, text) {
  const kind = (contentType ?? '').toLowerCase()
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return []
  if (kind.includes('text/event-stream')) {
    const messages = []
    for (const block of trimmed.split(/\r?\n\r?\n|\n\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data === '') continue
      try {
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed)) messages.push(...parsed)
        else messages.push(parsed)
      } catch {
        // A partial or non-JSON event is not a protocol message.
      }
    }
    return messages
  }
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Find the block boundary in a partially received SSE buffer. */
function findEventBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return { index: -1, length: 0 }
  if (crlf === -1) return { index: lf, length: 2 }
  if (lf === -1) return { index: crlf, length: 4 }
  return crlf < lf ? { index: crlf, length: 4 } : { index: lf, length: 2 }
}

/** Incrementally decode an SSE body into data payloads. */
async function* readSseEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = findEventBoundary(buffer)
        if (boundary.index === -1) break
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data !== '') yield data
      }
    }
  } finally {
    reader.releaseLock?.()
  }
}

/** Read a request body with a hard size ceiling. */
async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new BridgeError('body-too-large', 'request body exceeds the bridge limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write a JSON response, guarding against double responses. */
function sendJson(response, status, value, headers = {}) {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

/** Reply with a JSON-RPC error carrying one request id. */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}
/** Server info used before the editor has ever answered a handshake. */
function syntheticInitResult(version, protocolVersion) {
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: true },
      prompts: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: { name: 'mcp-for-unity-bridge', version },
    instructions: '',
  }
}

/**
 * The group a Unity MCP tool belongs to.
 *
 * The server never marks groups with a top-level field: a tool carries
 * `_meta.fastmcp.tags: ["group:<name>"]`, and an ungrouped tool (a server meta
 * tool such as `manage_tools`) carries no `group:` tag at all.
 *
 * @param tool - One tool definition from `tools/list`.
 * @returns The group name, or undefined for a tool that is always visible.
 */
function toolGroup(tool) {
  const tags = tool?._meta?.fastmcp?.tags
  if (!Array.isArray(tags)) return undefined
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.startsWith('group:')) {
      const group = tag.slice('group:'.length)
      if (group !== '') return group
    }
  }
  return undefined
}

/**
 * The tools a session may inject.
 *
 * A tool is hidden only when the server explicitly reports its group as
 * disabled. Everything else stays visible, which is what keeps newly added
 * tools working: a custom tool may carry a group tag the group manager does
 * not know yet (nobody could enable such a group), and a group entry may omit
 * `enabled` altogether. Both are treated as "not disabled", never as hidden.
 *
 * `manage_tools` is pinned visible by name on top of its missing tag: hiding
 * it would leave the agent no way to enable anything again.
 *
 * @param tools - Raw tool definitions from the server.
 * @param groups - Group state from {@link parseGroups}, or undefined when unknown.
 * @returns The subset to expose downstream.
 */
function visibleTools(tools, groups) {
  if (groups === undefined) return tools
  return tools.filter((tool) => {
    if (tool?.name === 'manage_tools') return true
    const group = toolGroup(tool)
    if (group === undefined) return true
    return !groups.disabled.has(group)
  })
}

/**
 * Group state from a `manage_tools {action: 'list_groups'}` reply.
 *
 * Only an explicit `enabled: false` marks a group disabled, so a malformed or
 * half-filled group entry keeps its tools visible.
 *
 * @param reply - The upstream JSON-RPC reply.
 * @returns Enabled and disabled group names, or undefined without any groups.
 */
function parseGroups(reply) {
  let groups = reply?.result?.structuredContent?.groups
  if (!Array.isArray(groups)) {
    const text = reply?.result?.content?.find((block) => block?.type === 'text')?.text
    if (typeof text === 'string') {
      try {
        groups = JSON.parse(text)?.groups
      } catch {
        groups = undefined
      }
    }
  }
  if (!Array.isArray(groups)) return undefined
  const enabled = new Set()
  const disabled = new Set()
  for (const group of groups) {
    if (group === null || typeof group !== 'object' || typeof group.name !== 'string' || group.name === '') continue
    if (group.enabled === true) enabled.add(group.name)
    else if (group.enabled === false) disabled.add(group.name)
  }
  return { enabled, disabled }
}

let messageCounter = 0

/** Monotonic ids for bridge-originated requests; never collide with client ids. */
function createMessageId() {
  messageCounter += 1
  return 'bridge-' + messageCounter
}

/** A session rejection the server answers before running anything. */
function isSessionLoss(response) {
  if (response.status === 404) return true
  if (response.status !== 400) return false
  return /session/i.test(response.text ?? '')
}

function notConnectedMessage(cause) {
  const suffix = cause === undefined ? '' : '（' + truncate(describe(cause), 160) + '）'
  return 'Unity 编辑器未连接：MCP 服务器不可用' + suffix
}

/**
 * The upstream half: one MCP session with the Unity server, plus the ability to
 * re-establish it at any time without telling anyone downstream.
 */
class UpstreamClient {
  #config
  #log
  #onNotification
  #sessionId
  #initResult
  #connecting = null
  #streamAbort = null
  #lastError

  constructor(config, log, onNotification) {
    this.#config = config
    this.#log = log
    this.#onNotification = onNotification
  }

  get connected() {
    return this.#sessionId !== undefined
  }

  get sessionId() {
    return this.#sessionId
  }

  get lastError() {
    return this.#lastError
  }

  /** Server info from the most recent successful handshake, kept across outages. */
  get initResult() {
    return this.#initResult
  }

  /**
   * Make sure a live upstream session exists, waiting at most waitMs.
   *
   * @param waitMs - Budget for a cold or recovering upstream.
   * @returns Whether the upstream is connected.
   */
  async ensure(waitMs) {
    if (this.#sessionId !== undefined) return true
    this.#connecting ??= this.#connect(waitMs).finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  /**
   * Forget the current session. The next ensure() performs a handshake.
   *
   * @param reason - Diagnostic text for the log.
   */
  invalidate(reason, options = {}) {
    const had = this.#sessionId !== undefined
    this.#sessionId = undefined
    this.#closeStream()
    if (!had || options.quiet === true) return
    this.#log('warn', '上游 Unity 会话已失效（' + reason + '），等待重新建立')
  }

  /** Forward a client notification (best effort, never throws). */
  notify(message, signal) {
    if (!this.connected) return
    void this.#post(message, this.#sessionId, this.#config.requestTimeoutMs, signal).catch(() => {})
  }

  /** Read the current tool list straight from the upstream session. */
  async listTools(timeoutMs = this.#config.requestTimeoutMs) {
    const request = { jsonrpc: '2.0', id: createMessageId(), method: 'tools/list' }
    const reply = await this.request(request, { waitMs: this.#config.listWaitMs, timeoutMs })
    if (reply.error !== undefined) throw new BridgeError('tools-list', reply.error.message ?? 'tools/list failed')
    return reply.result?.tools ?? []
  }

  /**
   * Issue one request, re-establishing the session and retrying exactly once
   * when the failure proves the request never ran.
   *
   * @param message - The JSON-RPC request to forward.
   * @param options - Wait budget, deadline, and caller cancellation.
   * @returns The upstream JSON-RPC reply, carrying the caller's id.
   */
  async request(message, options = {}) {
    const waitMs = options.waitMs ?? this.#config.listWaitMs
    const timeoutMs = options.timeoutMs ?? this.#config.requestTimeoutMs
    const signal = options.signal
    let failure
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const budget = attempt === 0 ? waitMs : Math.max(waitMs, this.#config.recoverWaitMs)
      if (!await this.ensure(budget)) {
        failure = this.#lastError
        throw new BridgeError('not-connected', notConnectedMessage(failure), { cause: failure })
      }
      let response
      try {
        response = await this.#post(message, this.#sessionId, timeoutMs, signal)
      } catch (error) {
        if (isDeadline(error)) throw new BridgeError('timeout', 'Unity MCP 请求超时', { cause: error })
        if (signal?.aborted) throw new BridgeError('canceled', '请求已取消', { cause: error })
        this.invalidate('请求失败：' + describe(error))
        failure = error
        if (attempt === 0 && isConnectionLost(error)) continue
        throw new BridgeError('network', '无法连接 Unity MCP 服务器：' + describe(error), { cause: error })
      }
      if (isSessionLoss(response)) {
        this.invalidate('服务器拒绝会话（HTTP ' + response.status + '）')
        failure = new BridgeError('session-lost', truncate(response.text))
        continue
      }
      const messages = extractMessages(response.contentType, response.text)
      const reply = messages.find((candidate) => candidate !== null && typeof candidate === 'object'
        && (candidate.result !== undefined || candidate.error !== undefined)
        && (candidate.id === message.id || candidate.id === 'server-error'))
      if (reply !== undefined) {
        return reply.id === message.id ? reply : { ...reply, id: message.id }
      }
      if (!response.ok) {
        failure = new BridgeError('http', 'Unity MCP 返回 HTTP ' + response.status + '：' + truncate(response.text))
        throw failure
      }
      throw new BridgeError('empty', 'Unity MCP 没有返回该请求的结果')
    }
    throw new BridgeError('not-connected', notConnectedMessage(failure), { cause: failure })
  }

  /** Stop the upstream session and its notification stream. */
  release(reason) {
    this.invalidate(reason, { quiet: true })
    this.#lastError = undefined
  }

  async #connect(waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      try {
        const handshake = await this.#handshake()
        this.#sessionId = handshake.sessionId
        this.#initResult = handshake.initResult
        this.#lastError = undefined
        this.#openStream()
        this.#log('info', '已建立到 Unity MCP 的会话（' + handshake.sessionId.slice(0, 8) + '…）')
        return true
      } catch (error) {
        this.#lastError = error
        if (Date.now() >= deadline) return false
        await sleep(300)
      }
    }
  }

  async #handshake() {
    const request = {
      jsonrpc: '2.0',
      id: createMessageId(),
      method: 'initialize',
      params: {
        protocolVersion: this.#config.protocolVersion,
        capabilities: {},
        clientInfo: { name: this.#config.clientName, version: this.#config.clientVersion },
      },
    }
    const response = await this.#post(request, undefined, 20000)
    if (!response.ok) throw new BridgeError('handshake', 'initialize 失败：HTTP ' + response.status + ' ' + truncate(response.text))
    const message = extractMessages(response.contentType, response.text)
      .find((candidate) => candidate?.id === request.id)
    if (message === undefined) throw new BridgeError('handshake', 'initialize 未返回结果')
    if (message.error !== undefined) throw new BridgeError('handshake', message.error.message ?? 'initialize 被拒绝')
    if (response.sessionId === undefined) throw new BridgeError('handshake', 'Unity MCP 未返回会话 id')
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, response.sessionId, 10000).catch(() => {})
    return { sessionId: response.sessionId, initResult: message.result }
  }

  async #post(message, sessionId, timeoutMs, signal) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId
    const deadline = AbortSignal.timeout(Math.max(1000, timeoutMs))
    const response = await fetch(this.#config.upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: combineSignals([deadline, signal]),
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      sessionId: response.headers.get('mcp-session-id') ?? undefined,
      text,
    }
  }

  #openStream() {
    this.#closeStream()
    const sessionId = this.#sessionId
    if (sessionId === undefined) return
    const controller = new AbortController()
    this.#streamAbort = controller
    void (async () => {
      try {
        const response = await fetch(this.#config.upstreamUrl, {
          method: 'GET',
          headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
          signal: controller.signal,
        })
        if (!response.ok || response.body === null) {
          await response.text().catch(() => {})
          if (!controller.signal.aborted) this.invalidate('通知流被拒绝（HTTP ' + response.status + '）')
          return
        }
        for await (const data of readSseEvents(response.body)) {
          let message
          try {
            message = JSON.parse(data)
          } catch {
            continue
          }
          if (message !== null && typeof message === 'object' && message.id === undefined && typeof message.method === 'string') {
            this.#onNotification?.(message)
          }
        }
        if (!controller.signal.aborted) this.invalidate('通知流结束')
      } catch (error) {
        if (!controller.signal.aborted) this.invalidate('通知流中断：' + describe(error))
      } finally {
        if (this.#streamAbort === controller) this.#streamAbort = null
      }
    })()
  }

  #closeStream() {
    const controller = this.#streamAbort
    this.#streamAbort = null
    controller?.abort()
  }
}
/**
 * The downstream half: an always-available MCP endpoint, a supervisor that
 * keeps the upstream warm, and a cache so a cold editor never costs a session
 * its tools.
 */
class Bridge {
  #config
  #log
  #upstream
  #server = null
  #loopTimer = null
  #stopped = false
  #subscribers = new Set()
  #clients = new Map()
  #state = {
    initResult: undefined,
    tools: undefined,
    toolsHash: undefined,
    visible: undefined,
    visibleHash: undefined,
  }
  #groups = { state: undefined, at: 0 }
  #groupRead = null
  #groupReadError = null
  #syncing = null
  #syncQueued = false
  #syncSerial = 0
  #stateLoaded = null
  #persistTimer = null
  #listening = false

  constructor(config, log) {
    this.#config = config
    this.#log = log
    this.#upstream = new UpstreamClient(config, log, (message) => this.#onUpstreamNotification(message))
  }

  /**
   * Bind the endpoint and start supervising.
   *
   * @returns An object whose state is 'listening', 'external', or 'retrying'.
   */
  async start() {
    this.#stopped = false
    const outcome = await this.#attemptBind()
    this.#schedule()
    return outcome
  }

  /** One bind attempt: claim the port, or discover who already owns it. */
  async #attemptBind() {
    if (this.#listening) return { state: 'listening' }
    await this.#loadState()
    try {
      await this.#listen()
      return { state: 'listening' }
    } catch (error) {
      if (error?.code === 'EADDRINUSE') {
        const existing = await this.#probeExisting()
        if (existing) {
          // Another Host owns the endpoint. Its bridge serves both of us until
          // it exits, at which point the supervisor below takes the port over.
          this.#log('info', '端口 ' + this.#config.port + ' 已被另一个桥接实例占用，复用该实例')
          return { state: 'external' }
        }
        this.#log('error', '端口 ' + this.#config.port + ' 已被其它程序占用，稍后重试')
      } else {
        this.#log('error', '监听 ' + this.#config.host + ':' + this.#config.port + ' 失败：' + describe(error))
      }
      return { state: 'retrying' }
    }
  }

  /** Close the endpoint, the upstream session, and every downstream stream. */
  stop() {
    this.#stopped = true
    if (this.#loopTimer !== null) clearTimeout(this.#loopTimer)
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer)
    this.#loopTimer = null
    this.#persistTimer = null
    this.#upstream.release('bridge shutdown')
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.end()
      } catch {
        // The socket is already gone.
      }
    }
    this.#subscribers.clear()
    this.#clients.clear()
    const server = this.#server
    this.#server = null
    this.#listening = false
    server?.close()
    server?.closeAllConnections?.()
  }

  /** Diagnostic snapshot for the health endpoint. */
  status() {
    return {
      ok: true,
      service: BRIDGE_SERVICE,
      listening: this.#listening,
      upstream: {
        url: this.#config.upstreamUrl,
        connected: this.#upstream.connected,
        sessionId: this.#upstream.sessionId ?? null,
        lastError: this.#upstream.lastError === undefined ? null : truncate(describe(this.#upstream.lastError), 300),
        tools: this.#state.tools?.length ?? 0,
        visible: this.#state.visible?.length ?? 0,
        groups: this.#groups.state === undefined ? null : [...this.#groups.state.enabled].sort(),
      },
      clients: this.#clients.size,
      subscribers: this.#subscribers.size,
    }
  }

  async #listen() {
    const server = http.createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, rpcError(null, -32603, describe(error)))
        else response.destroy()
      })
    })
    server.keepAliveTimeout = 720000
    server.headersTimeout = 730000
    server.requestTimeout = 0
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.#config.port, this.#config.host)
    })
    server.on('error', (error) => this.#log('error', '桥接服务错误：' + describe(error)))
    this.#server = server
    this.#listening = true
    this.#log('info', '桥接服务监听 http://' + this.#config.host + ':' + this.#config.port + '/mcp → ' + this.#config.upstreamUrl)
  }

  async #probeExisting() {
    try {
      const response = await fetch('http://' + this.#config.host + ':' + this.#config.port + '/health', {
        signal: AbortSignal.timeout(2000),
      })
      if (!response.ok) return false
      const status = await response.json()
      return status?.service === BRIDGE_SERVICE
    } catch {
      return false
    }
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? '127.0.0.1'))
    if (url.pathname === '/health') {
      sendJson(response, 200, this.status())
      return
    }
    if (url.pathname !== '/mcp') {
      sendJson(response, 404, rpcError(null, -32601, 'not found'))
      return
    }
    switch (request.method) {
      case 'POST':
        await this.#handlePost(request, response)
        return
      case 'GET':
        this.#openStream(response)
        return
      case 'DELETE': {
        const sessionId = headerSession(request)
        if (sessionId !== undefined) this.#clients.delete(sessionId)
        request.resume()
        if (!response.headersSent) response.writeHead(200, { 'content-length': 0 }).end()
        return
      }
      default:
        request.resume()
        sendJson(response, 405, rpcError(null, -32600, 'method not allowed'))
    }
  }

  async #handlePost(request, response) {
    // A client that disconnects mid-call must cancel the upstream request, but
    // IncomingMessage also emits 'close' once the body is fully read: only the
    // response socket closing before we answered means the caller went away.
    const controller = new AbortController()
    response.on('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    let raw
    try {
      raw = await readBody(request, this.#config.maxBodyBytes)
    } catch (error) {
      sendJson(response, 413, rpcError(null, -32600, describe(error)))
      return
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      sendJson(response, 400, rpcError(null, -32700, 'Parse error'))
      return
    }
    const sessionId = headerSession(request)
    if (sessionId !== undefined) this.#clients.set(sessionId, Date.now())
    if (Array.isArray(payload)) {
      // The DSH client sends one message per POST; a batch is relayed as-is.
      const result = await this.#relayBatch(payload, controller.signal)
      sendJson(response, result.status, result.body)
      return
    }
    const message = payload
    if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
      sendJson(response, 400, rpcError(message?.id ?? null, -32600, 'Invalid Request'))
      return
    }
    if (message.id === undefined) {
      if (message.method !== 'notifications/initialized') this.#upstream.notify(message, controller.signal)
      response.writeHead(202, { 'content-length': 0 }).end()
      return
    }
    if (message.method === 'initialize') {
      const result = await this.#initialize(message)
      sendJson(response, result.status, result.body, result.headers)
      return
    }
    const syncMark = this.#syncSerial
    const reply = await this.#dispatch(message, controller.signal)
    // A tool call may have changed the tool list (manage_tools does, every
    // time). Let a refresh that this call provoked land before the reply
    // leaves, so the client re-registers at the tool-step boundary instead of
    // in the middle of the next step's tool admission.
    if (message.method === 'tools/call' && this.#syncSerial !== syncMark) await this.#settleSync()
    sendJson(response, 200, reply)
  }

  async #initialize(message) {
    const sessionId = randomUUID().replaceAll('-', '')
    this.#clients.set(sessionId, Date.now())
    await this.#upstream.ensure(this.#config.connectWaitMs)
    const live = this.#upstream.initResult
    if (live !== undefined) this.#state.initResult = live
    const result = live
      ?? this.#state.initResult
      ?? syntheticInitResult(this.#config.clientVersion, this.#config.protocolVersion)
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: message.id, result },
      headers: { 'mcp-session-id': sessionId },
    }
  }

  async #dispatch(message, signal) {
    switch (message.method) {
      case 'ping':
        void this.#upstream.ensure(0)
        return { jsonrpc: '2.0', id: message.id, result: {} }
      case 'server/discover': {
        // The client's era probe: any JSON-RPC error classifies as "legacy",
        // which is what the Unity server is. Never let a cold editor turn this
        // into a transport failure, or the client refuses to connect at all.
        try {
          return await this.#upstream.request(message, { waitMs: 0, timeoutMs: 5000, signal })
        } catch {
          return rpcError(message.id, -32601, 'Method not found')
        }
      }
      case 'tools/list':
        return this.#toolsList(message, signal)
      case 'tools/call': {
        try {
          return await this.#upstream.request(message, {
            waitMs: this.#config.callWaitMs,
            timeoutMs: this.#config.requestTimeoutMs,
            signal,
          })
        } catch (error) {
          return rpcError(message.id, -32000, describe(error))
        }
      }
      default:
        try {
          return await this.#upstream.request(message, {
            waitMs: this.#config.listWaitMs,
            timeoutMs: this.#config.requestTimeoutMs,
            signal,
          })
        } catch (error) {
          return rpcError(message.id, -32000, describe(error))
        }
    }
  }

  async #toolsList(message, signal) {
    try {
      const reply = await this.#upstream.request(message, {
        waitMs: this.#config.listWaitMs,
        timeoutMs: this.#config.requestTimeoutMs,
        signal,
      })
      if (!Array.isArray(reply.result?.tools)) return reply
      const groups = await this.#refreshGroups(false)
      this.#applyTools(reply.result.tools, groups)
      return { ...reply, result: { ...reply.result, tools: this.#state.visible ?? reply.result.tools } }
    } catch (error) {
      const cached = this.#state.visible ?? this.#state.tools
      if (Array.isArray(cached) && cached.length > 0) {
        this.#log('warn', 'tools/list 使用缓存（' + describe(error) + '）')
        return { jsonrpc: '2.0', id: message.id, result: { tools: cached } }
      }
      return { jsonrpc: '2.0', id: message.id, result: { tools: [] } }
    }
  }

  async #relayBatch(messages, signal) {
    const requests = messages.filter((message) => message?.id !== undefined)
    for (const message of messages) {
      if (message?.id === undefined && message?.method !== undefined && message.method !== 'notifications/initialized') {
        this.#upstream.notify(message, signal)
      }
    }
    if (requests.length === 0) return { status: 202, body: {} }
    const replies = []
    for (const request of requests) replies.push(await this.#dispatch(request, signal))
    return { status: 200, body: replies }
  }

  #openStream(response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': dsh-unity-mcp-bridge\n\n')
    const subscriber = response
    this.#subscribers.add(subscriber)
    const timer = setInterval(() => {
      try {
        subscriber.write(': keepalive\n\n')
      } catch {
        // Closed between the check and the write.
      }
    }, this.#config.keepaliveMs)
    timer.unref?.()
    const cleanup = () => {
      clearInterval(timer)
      this.#subscribers.delete(subscriber)
    }
    response.on('close', cleanup)
    response.on('error', cleanup)
  }

  #broadcast(message) {
    if (this.#subscribers.size === 0) return
    const frame = 'event: message\ndata: ' + JSON.stringify(message) + '\n\n'
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.write(frame)
      } catch {
        this.#subscribers.delete(subscriber)
      }
    }
  }

  #onUpstreamNotification(message) {
    if (message.method === 'notifications/tools/list_changed') {
      // Unity announces a change on every group toggle, and its list is the
      // same before and after: the injected subset only moves when a group
      // actually flips. Forwarding the raw notification makes the client
      // re-register every tool, which retires the definitions the running
      // step was admitted with, so a call in that step fails as an unknown
      // tool. Refresh first; notify downstream only if the subset moved.
      void this.#requestSync()
      return
    }
    this.#broadcast(message)
  }

  /**
   * Refuse to run two refreshes at once, and fold a request that arrives
   * while one is running into exactly one more pass.
   *
   * @returns The drain promise, so a caller may wait for the result.
   */
  #requestSync() {
    if (this.#syncing !== null) {
      this.#syncQueued = true
      this.#syncSerial += 1
      return this.#syncing
    }
    const run = this.#drainSync()
    this.#syncing = run
    this.#syncSerial += 1
    void run.finally(() => {
      if (this.#syncing === run) this.#syncing = null
    })
    return run
  }

  async #drainSync() {
    do {
      this.#syncQueued = false
      try {
        await this.#syncTools()
      } catch (error) {
        this.#log('warn', '刷新工具列表失败：' + describe(error))
      }
    } while (this.#syncQueued)
  }

  /**
   * Give an in-flight refresh a bounded chance to finish before a tool reply
   * leaves, so the downstream client re-syncs between steps rather than
   * during one.
   */
  async #settleSync() {
    const run = this.#syncing
    if (run === null) return
    await Promise.race([run, sleep(this.#config.syncSettleMs)])
  }

  /**
   * Read the enabled tool groups from the server.
   *
   * Group state is session state on the Unity side, so it is re-read whenever
   * the tool list changes and reused briefly otherwise. A failed read keeps
   * the last known set; while nothing is known every tool stays visible, so a
   * server without groups (or a cold editor) never loses tools.
   *
   * @param force - Ignore the cached read even when it is still fresh.
   * @returns Group state, or undefined when none is known.
   */
  async #refreshGroups(force) {
    if (!this.#config.groupFilter) return undefined
    if (!force && this.#groups.state !== undefined && Date.now() - this.#groups.at < this.#config.groupStateMs) {
      return this.#groups.state
    }
    if (this.#groupRead !== null) return this.#groupRead
    this.#groupRead = (async () => {
      try {
        const reply = await this.#upstream.request({
          jsonrpc: '2.0',
          id: createMessageId(),
          method: 'tools/call',
          params: { name: 'manage_tools', arguments: { action: 'list_groups' } },
        }, { waitMs: 0, timeoutMs: Math.min(this.#config.requestTimeoutMs, 5000) })
        const state = parseGroups(reply)
        if (state === undefined) {
          throw new BridgeError('groups', reply?.error?.message ?? 'manage_tools 未返回分组信息')
        }
        this.#groups = { state, at: Date.now() }
        if (this.#groupReadError !== null) {
          this.#groupReadError = null
          this.#log('info', '工具分组状态已可读')
        }
        return state
      } catch (error) {
        if (this.#groupReadError === null) {
          this.#groupReadError = describe(error)
          this.#log('warn', '读取工具分组状态失败，暂时暴露全部工具：' + this.#groupReadError)
        }
        return this.#groups.state
      } finally {
        this.#groupRead = null
      }
    })()
    return this.#groupRead
  }

  /**
   * Store a fresh upstream tool list and derive the injectable subset.
   *
   * @param tools - Raw tool definitions from the server.
   * @param groups - Group state, or undefined to expose everything.
   * @returns Whether the injectable subset changed since the last call.
   */
  #applyTools(tools, groups) {
    const toolsHash = createHash('sha256').update(JSON.stringify(tools)).digest('hex')
    if (toolsHash !== this.#state.toolsHash) {
      this.#state.tools = tools
      this.#state.toolsHash = toolsHash
      this.#persist()
    }
    const visible = groups === undefined ? tools : visibleTools(tools, groups)
    const visibleHash = createHash('sha256').update(JSON.stringify(visible)).digest('hex')
    if (visibleHash === this.#state.visibleHash) return false
    this.#state.visible = visible
    this.#state.visibleHash = visibleHash
    this.#persist()
    return true
  }

  async #syncTools() {
    if (!this.#upstream.connected) return
    const tools = await this.#upstream.listTools()
    const groups = await this.#refreshGroups(true)
    if (!this.#applyTools(tools, groups)) return
    const visible = this.#state.visible ?? tools
    const hidden = tools.length - visible.length
    this.#log('info', 'Unity MCP 可见工具已更新（' + visible.length + ' 个'
      + (hidden > 0 ? '，隐藏 ' + hidden + ' 个未启用组工具' : '') + '），通知下游重新同步')
    this.#broadcast({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  /**
   * One supervised loop for the whole row: it retries the bind while the
   * endpoint is missing, and it keeps the upstream warm while clients exist.
   *
   * @param delayMs - Delay before the next iteration.
   */
  #schedule(delayMs = this.#config.idlePollMs) {
    if (this.#stopped || this.#loopTimer !== null) return
    this.#loopTimer = setTimeout(() => {
      this.#loopTimer = null
      void this.#tick().then(
        (next) => {
          this.#schedule(next)
        },
        (error) => {
          this.#log('error', '桥接监督循环出错：' + describe(error))
          this.#schedule(this.#config.idlePollMs)
        },
      )
    }, delayMs)
    this.#loopTimer.unref?.()
  }

  async #tick() {
    if (!this.#listening) {
      const outcome = await this.#attemptBind()
      return outcome.state === 'listening' ? this.#config.pollDownMs : 5000
    }
    this.#pruneClients()
    if (this.#clients.size === 0) {
      if (this.#upstream.connected) this.#upstream.release('没有活动的下游会话')
      return this.#config.idlePollMs
    }
    const wasUp = this.#upstream.connected
    const up = await this.#upstream.ensure(0)
    if (!up) {
      if (wasUp) this.#log('warn', 'Unity MCP 连接已断开，等待编辑器恢复…')
      return this.#config.pollDownMs
    }
    if (!wasUp) this.#log('info', '已重新连接 Unity MCP 服务器')
    await this.#requestSync()
    return this.#config.pollUpMs
  }

  #pruneClients() {
    const now = Date.now()
    for (const [sessionId, lastSeen] of this.#clients) {
      if (now - lastSeen > this.#config.clientIdleMs) this.#clients.delete(sessionId)
    }
  }

  async #loadState() {
    if (this.#stateLoaded !== null) return this.#stateLoaded
    this.#stateLoaded = (async () => {
      if (this.#config.stateFile === '') return
      try {
        const raw = await readFile(this.#config.stateFile, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed?.initResult !== undefined) this.#state.initResult = parsed.initResult
        if (Array.isArray(parsed?.tools)) {
          this.#state.tools = parsed.tools
          this.#state.toolsHash = createHash('sha256').update(JSON.stringify(parsed.tools)).digest('hex')
        }
        if (Array.isArray(parsed?.visible)) {
          this.#state.visible = parsed.visible
          this.#state.visibleHash = createHash('sha256').update(JSON.stringify(parsed.visible)).digest('hex')
        }
        if (Array.isArray(parsed?.groups)) {
          // `at: 0` keeps the first read cheap but current: group state is
          // server-session state, so a cached copy is only a cold-start guess.
          this.#groups = {
            state: {
              enabled: new Set(parsed.groups.filter((name) => typeof name === 'string')),
              disabled: new Set((Array.isArray(parsed.disabledGroups) ? parsed.disabledGroups : []).filter((name) => typeof name === 'string')),
            },
            at: 0,
          }
        }
      } catch {
        // A missing or unreadable cache only costs a cold first connect.
      }
    })()
    return this.#stateLoaded
  }

  #persist() {
    if (this.#config.stateFile === '') return
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer)
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null
      void (async () => {
        try {
          await mkdir(dirname(this.#config.stateFile), { recursive: true })
          await writeFile(this.#config.stateFile, JSON.stringify({
            initResult: this.#state.initResult,
            tools: this.#state.tools,
            visible: this.#state.visible,
            groups: this.#groups.state === undefined ? [] : [...this.#groups.state.enabled],
            disabledGroups: this.#groups.state === undefined ? [] : [...this.#groups.state.disabled],
            savedAt: new Date().toISOString(),
          }, undefined, 2), 'utf8')
        } catch {
          // Persistence is a convenience, never a requirement.
        }
      })()
    }, 250)
    this.#persistTimer.unref?.()
  }
}

function headerSession(request) {
  const value = request.headers['mcp-session-id']
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Create a bridge instance.
 *
 * @param options - Plugin row config; unset fields use the defaults above.
 * @returns Handle with start/stop/status and the public URL.
 */
export function createBridge(options = {}) {
  const config = resolveConfig(options)
  const log = typeof options.log === 'function' ? options.log : (level, message) => {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink('unity-mcp-bridge: ' + message)
  }
  const bridge = new Bridge(config, log)
  return {
    start: () => bridge.start(),
    stop: () => bridge.stop(),
    status: () => bridge.status(),
    url: 'http://' + config.host + ':' + config.port + '/mcp',
  }
}



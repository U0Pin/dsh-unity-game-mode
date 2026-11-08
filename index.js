/**
 * Host half of the Unity game development bundle (DSH).
 *
 * The bundle's real job is the preset row that loads the Unity MCP connection,
 * but that connection needs a stable MCP endpoint to talk to: the editor's own
 * server dies with the editor and takes every session id with it. This row runs
 * the streamable-HTTP bridge that owns the upstream session (see ./bridge.js),
 * so the preset's MCP client can stay connected across editor restarts.
 *
 * The row is inert until a Unity session connects to it: with no downstream
 * client the supervisor sleeps and holds no upstream session. It also refuses
 * to fight another Host instance - a second bridge on the same port is reused
 * rather than duplicated.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from './bridge.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'unity-mcp-bridge'

/** Default location of the cached server info and tool list. */
const DEFAULT_STATE_FILE = join(homedir(), '.dsh', 'cache', 'unity-mcp-bridge.json')

/**
 * Start the bridge for the lifetime of this plugin instance.
 *
 * @param ctx - Cordis context supplying the logger and effect lifetime.
 * @param config - Row config: port, upstreamUrl, and timing knobs.
 */
export function apply(ctx, config) {
  const row = config !== null && typeof config === 'object' ? config : {}
  const options = { ...row }
  if (options.stateFile === undefined) options.stateFile = DEFAULT_STATE_FILE
  const log = (level, message) => {
    const logger = ctx.logger
    const sink = level === 'error' ? logger?.error : level === 'warn' ? logger?.warn : logger?.info
    const text = 'unity-mcp-bridge: ' + message
    if (typeof sink === 'function') sink.call(logger, text)
    else if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  }
  const bridge = createBridge({ ...options, log })
  ctx.effect(() => {
    void bridge.start().then((outcome) => {
      if (outcome?.state === 'external') log('info', '复用已在运行的桥接实例')
    }).catch((error) => {
      log('error', '桥接服务启动失败：' + (error instanceof Error ? error.message : String(error)))
    })
    return () => bridge.stop()
  }, 'unity-mcp-bridge.server')
}

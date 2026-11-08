/**
 * Host half of the Unity game development bundle (DSH): the `unity-mcp-bridge`
 * row, which runs the streamable-HTTP bridge from ./bridge.js so the preset's
 * MCP client keeps one endpoint across editor restarts.
 *
 * The row is inert until a Unity session connects, and a second Host on the
 * same port reuses the running bridge rather than duplicating it.
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

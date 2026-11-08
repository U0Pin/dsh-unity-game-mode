# 开发与维护

面向修改这个包的人。安装、使用和排障入口见 [README.md](README.md)。

## 仓库结构

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单；`files` 白名单决定发布内容，`engines.dsh` 声明兼容的 DSH 版本 |
| `cordis.patch.yml` | 组合补丁：`unity` 模式的子插件清单 + profile 级 `unity-mcp-bridge` 行 |
| `index.js` | 桥接插件入口，绑定到 `unity-mcp-bridge` 行 |
| `bridge.js` | 桥接实现与 session 语义 |
| `locale/{zh,en}.json` | 插件列表里的显示名与说明 |
| `icon.svg` | 插件图标 |
| `test/` | 自检，不随包分发 |
| 上游 | [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp)（MCP for Unity，MIT）：编辑器侧服务器，不随包分发 |

仓库根目录即包：安装器按仓库地址取包时，拿到的就是 `files` 白名单里的内容。

## 桥接与失效语义

Unity 的 MCP 服务器（[MCP for Unity](https://github.com/CoplayDev/unity-mcp)）随编辑器启停，编辑器重启会带走所有 MCP 会话：带旧 `mcp-session-id` 的请求返回 `404 {"code": -32600, "message": "Session not found"}`。streamable-HTTP 传输不为此报 `onclose`，DSH 的 MCP 客户端不会自己发现，工具仍注册着，后续调用全部失败，只能重开对话恢复。

`bridge.js` 接管上游会话，对外提供一个不随编辑器消失的服务器：

```
DSH 会话 ──HTTP──▶ unity-mcp-bridge (127.0.0.1:18080/mcp) ──HTTP──▶ Unity MCP (127.0.0.1:8080/mcp)
```

- `initialize` 立即返回：编辑器在线时是真实服务器信息，离线时是上次缓存或占位信息。编辑器关着也能开对话，工具不会掉。
- 请求被转发；上游会话失效时桥接重建会话并把该请求重发一次。会话失效意味着服务器在执行之前就拒绝了请求，重发安全。
- `tools/list` 在编辑器离线时退回缓存；监督循环在编辑器回来后重读，注入给模型的集合有变化才向下游广播 `notifications/tools/list_changed`。
- 只注入没有被明确禁用的分组工具：分组由工具自带的 `_meta.fastmcp.tags: ["group:<name>"]` 标记，`manage_tools {action:"list_groups"}` 返回 `enabled: false` 的分组才隐藏；没有分组标签的工具（`manage_tools` 及其它元工具）永远保留；读不到分组状态时全部放行。
- 有下游会话时监督循环轮询上游，避免服务器 30 分钟的会话空闲超时。
- 端口被占用是安全的：第二个 Host 复用已在跑的桥接实例；先启动的 Host 退出后，剩下的在几秒内接管端口。

分组状态是上游会话级的，而桥接只维持一条上游会话，所以同时开着多个 Unity 对话时它们共享分组；编辑器重启后分组回到默认，桥接把可见集合同步回默认。

## 配置

行配置透传给 `createBridge`：未设置的项取 `bridge.js` 里 `DEFAULTS` 的值，`index.js` 另外补上 `stateFile` 的默认值。改端口要同步修改 `unity-mcp` 行的 `url`。

## 诊断

`curl http://127.0.0.1:18080/health` 返回 `status()` 的快照：上游连接状态与会话 id、工具总数与注入数（`tools`/`visible`）、已启用分组、下游会话数与订阅流数量。

Host 日志里 `unity-mcp-bridge:` 前缀的行记录连接、失效、重建与工具列表变化。桥接把最近一次的服务器信息与工具列表缓存到 `~/.dsh/cache/unity-mcp-bridge.json`，冷启动时先注册这些工具。

## 自检

`npm test` 跑插件契约测试与桥接自测，两者也可分别用 `node test/plugin-contract.test.mjs`、`node test/bridge.test.mjs` 运行。桥接自测用假上游；需要真实服务器的用例只在本机 `127.0.0.1:8080` 可用时执行，否则跳过。

## 本地开发

用「本地目录」安装即链接安装。改 `cordis.patch.yml` 需卸载重装；改 `index.js`/`bridge.js` 重启 Host 即可。

## 兼容性与维护

- `cordis.patch.yml` 的子插件清单是 DSH 自带 `ptc` 模式的拷贝，不是官方发行物；对外分发前确认相关条款。
- 应用升级后手动同步该清单、核对 `engines.dsh` 并升包版本。`engines.dsh` 锁在同一条小版本线上，跨线安装会被安装阶段拒绝，这是有意的。
- 0.x 是测试版：次版本号提升可能带来不兼容变化。
- 上游 MCP for Unity 有独立发布节奏，本包不锁定其版本。桥接依赖它的 streamable-HTTP 传输、`manage_tools` 的 `list_groups` 输出和工具上的 `_meta.fastmcp.tags`；这些契约变化时桥接要跟着改。

## 发版

1. 改 `package.json` 版本号，同步 README 安装示例里的标签；应用版本变化时同步 `engines.dsh`。
2. `npm test` 通过后提交并推送 `main`，打标签 `v<version>` 并推送标签；发布说明写在标签注解里。
3. 通知使用者卸载旧版、按新标签安装。

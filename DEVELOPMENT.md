# 开发与维护

面向修改这个包的人。安装、使用与排障见 [README.md](README.md)。

## 为什么需要桥

Unity 的 MCP 服务器（[MCP for Unity](https://github.com/CoplayDev/unity-mcp)）随编辑器启停，编辑器重启会带走所有会话：带旧 `mcp-session-id` 的请求返回 `404 {"code": -32600, "message": "Session not found"}`。streamable-HTTP 不为此报 `onclose`，DSH 的 MCP 客户端不会自己发现，工具仍注册着、调用全部失败，只能重开对话。

`bridge.js` 接管上游会话，对外提供一个不随编辑器消失的端点；`index.js` 只是把它挂到 `unity-mcp-bridge` 行上。

```
DSH 会话 ──HTTP──▶ unity-mcp-bridge (127.0.0.1:18080/mcp) ──HTTP──▶ Unity MCP (127.0.0.1:8080/mcp)
```

## 桥的约定

- `initialize` 立即返回：编辑器在线时给真实服务器信息，离线时给上次缓存或占位信息，所以编辑器关着也能开对话。
- 上游会话失效时重建会话并把该请求重发一次；只有「服务器执行前就拒绝」才算失效，所以重发安全。
- `tools/list` 在编辑器离线时退回缓存；监督循环在编辑器回来后重读，注入的集合有变化才向下游广播 `notifications/tools/list_changed`。
- 只注入没有被明确禁用的分组工具：分组取自工具的 `_meta.fastmcp.tags: ["group:<name>"]`，`manage_tools {action:"list_groups"}` 报 `enabled: false` 的才隐藏；没有分组标签的工具（`manage_tools` 等元工具）永远保留；读不到分组状态时全部放行。
- 分组是上游会话级状态，而桥只维持一条上游会话：同时开多个 Unity 对话会共享分组，编辑器重启后回到默认并同步给下游。
- 有下游会话时轮询上游，避开 30 分钟会话空闲超时；没有下游会话时释放上游会话。
- 端口被占用是安全的：第二个 Host 复用已在跑的实例；先启动的退出后，剩下的在几秒内接管。
- 改端口要同时改 `cordis.patch.yml` 里 `unity-mcp` 行的 `url`。

## 诊断

`curl http://127.0.0.1:18080/health` 返回 `status()` 快照：上游连接状态与会话 id、工具总数与注入数（`tools`/`visible`）、已启用分组、下游会话数与订阅流数。

Host 日志里 `unity-mcp-bridge:` 前缀的行记录连接、失效、重建与工具列表变化。最近一次的服务器信息与工具列表缓存在 `~/.dsh/cache/unity-mcp-bridge.json`，冷启动时先注册这些工具。

## 打包与发版

- 安装单位是 git 标签：用户装 `#v<version>` 对应的仓库内容，没有 npm 发布、没有自动更新。发版 = 改 `package.json` 版本号、同步 README 里的标签、打标签推送，说明写在标签注解里。
- 改 `cordis.patch.yml` 需卸载重装，改 `index.js`/`bridge.js` 重启 Host 即可。
- `cordis.patch.yml` 的子插件清单是 DSH 自带 `ptc` 预设的拷贝，不是稳定接口：应用升级后手动同步，别只改版本号。
- `engines.dsh` 是 `>=0.2.2-rc.1 <0.3.0`，范围外的 DSH 在安装阶段就被拒绝；只有实测过的版本线变了才调整。

## 上游依赖

桥依赖 MCP for Unity 的三处契约：streamable-HTTP 传输、`manage_tools` 的 `list_groups` 输出、工具上的 `_meta.fastmcp.tags`。它有独立发布节奏，本包不锁版本；这三处变了桥要跟着改。

## 自检

`npm test` 跑插件契约测试与桥接自测。真机用例只在本机 `127.0.0.1:8080` 有 Unity MCP 时执行，否则跳过——没有它就无法证明「编辑器重启后调用仍然成功」。

# Unity 游戏开发模式（DSH bundle）

`dsh-unity-game-mode` 注册对话模式 `unity游戏开发`，并为该模式提供一条能扛住 Unity 重启的 MCP 连接。

## 安装

前置条件，每位安装者自己的机器：

- DSH 版本满足 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.1 <0.2.3-0`）；不符时安装阶段被拒。
- 本机已登录 GitHub。私有仓库按本机凭据读取，安装框没有密码输入。
- Unity 已启动 `MCP for Unity`，监听 `127.0.0.1:8080`。未启动也能安装、开对话，只是调用工具会报「编辑器未连接」。

步骤：

1. 打开 **添加插件**，填仓库地址并带版本标签，`<org>/<repo>` 换成本仓库地址：

   ```
   https://github.com/<org>/<repo>#v1.1.0
   ```

   安装器解析不了时改用 `git+https://github.com/<org>/<repo>.git#v1.1.0`。
2. 新建对话时在模式列表选 `unity游戏开发`。模式在对话开始后不能更换。

## 升级与卸载

- 第三方 bundle 不自动更新：升级 = 卸载后按新标签重装。
- 不填标签装到的是默认分支最新提交，没有可回退的版本；分享时始终带标签。
- 卸载：插件管理里 `remove_bundle`，目标 `dsh-unity-game-mode`。

## 这个模式包含什么

| 项 | 值 |
|---|---|
| 模式名 | `unity游戏开发` |
| preset id | `unity` |
| 组合 | 完整复制应用自带的 `ptc` 模式，末尾追加一条 Unity MCP 连接 |
| 顺序 | 5（排在自带四个模式之后） |
| profile 级额外注册 | 一行 `unity-mcp-bridge`（见下） |

只有选了这个模式的对话才有 Unity 工具；其它模式（`standard`/`ptc`/`minimal`/`cordis`）不受影响，也没有那批 `mcp__unity__*` 工具。

## 桥接与失效语义

Unity 的 MCP 服务器随编辑器启停，编辑器重启会带走所有 MCP 会话：带旧 `mcp-session-id` 的请求返回 `404 {"code": -32600, "message": "Session not found"}`。streamable-HTTP 传输不为此报 `onclose`，DSH 的 MCP 客户端不会自己发现，工具仍注册着，后续调用全部失败，只能重开对话恢复。

`bridge.js` 接管上游会话，对外提供一个不随编辑器消失的服务器：

```
DSH 会话 ──HTTP──▶ unity-mcp-bridge (127.0.0.1:18080/mcp) ──HTTP──▶ Unity MCP (127.0.0.1:8080/mcp)
```

- `initialize` 立即返回：编辑器在线时是真实服务器信息，离线时是上次缓存或占位信息。编辑器关着也能开对话，工具不会掉。
- 请求被转发；上游会话失效时桥接重建会话并把该请求重发一次。会话失效意味着服务器在执行之前就拒绝了请求，重发安全。
- `tools/list` 在编辑器离线时退回缓存；监督循环在编辑器回来后重读，注入给模型的集合有变化才向下游广播 `notifications/tools/list_changed`。
- 只注入已启用分组的工具：`manage_tools {action:"list_groups"}` 的 `enabled` 与工具自带的 `_meta.fastmcp.tags: ["group:<name>"]` 求交集；没有分组标签的工具（`manage_tools` 及其它元工具）永远保留；读不到分组状态时全部放行。
- 有下游会话时监督循环轮询上游，避免服务器 30 分钟的会话空闲超时。
- 端口被占用是安全的：第二个 Host 复用已在跑的桥接实例；先启动的 Host 退出后，剩下的在几秒内接管端口。

## 使用

Unity 工具依赖编辑器侧 `Window > MCP for Unity` 启动的 `http://127.0.0.1:8080`。服务没起来时桥接照常在线，工具仍在，调用明确报「Unity 编辑器未连接」；编辑器打开后工具自动可用。

默认只注入已启用分组（开箱只有 `core`，30 个工具；全部分组 49 个）。其余分组由 agent 调 `manage_tools` 激活。判定规则是只有服务器明确报告某组未启用时才隐藏该组工具，所以没有分组标签的工具、以及 `list_groups` 里还没出现的新工具一律照常注入：新增工具不需要重启桥接。

分组状态是上游会话级的，桥接只维持一条上游会话，所以同时开着多个 Unity 对话时它们共享分组；编辑器重启后分组回到默认，桥接把可见集合同步回默认。

## 诊断

```
curl http://127.0.0.1:18080/health
```

返回上游是否连接、当前上游会话 id、工具数量（`tools` 为服务器列出的总数，`visible` 为实际注入的数量，`groups` 为已启用分组）、下游会话数与订阅流数量。Host 日志里 `unity-mcp-bridge:` 前缀的行记录连接、失效、重建与工具列表变化。桥接把最近一次的服务器信息与工具列表缓存到 `~/.dsh/cache/unity-mcp-bridge.json`，冷启动时先注册这些工具。

## 配置

参数与默认值以 `cordis.patch.yml` 的 `unity-mcp-bridge` 行为准，包括 `port`/`host`、`upstreamUrl`、`callWaitMs`、`pollUpMs`/`pollDownMs`、`groupFilter`、`groupStateMs`。改端口时同步修改 `unity-mcp` 行的 `url`。

## 维护

- 仓库根目录即包。`files` 白名单决定发布内容，`test/` 与说明文件不随包分发。
- 模式不支持继承：`cordis.patch.yml` 的子插件清单是 DSH `0.2.2-rc.1` 自带 `ptc` 模式的拷贝，不是官方发行物。应用升级后手动同步该清单、核对 `engines.dsh` 并升包版本；对外分发前确认相关条款。
- 自检 `npm test`：插件契约测试，再桥接自测；真实 Unity 场景只在本机 `8080` 可用时执行。
- 本地开发用「本地目录」安装（链接安装）。改 `cordis.patch.yml` 需卸载重装；改 `index.js`/`bridge.js` 重启 Host 即可。

## 发版

1. 改 `package.json` 版本号；应用版本变化时同步 `engines.dsh`。
2. `npm test` 通过后提交并推送 `main`，打标签 `v<version>` 并推送标签；发布说明写在标签注解里。
3. 通知使用者卸载旧版、按新标签安装。

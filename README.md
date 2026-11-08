# Unity 游戏开发模式（DSH bundle）

`dsh-unity-game-mode` 给 DSH 加一个对话模式 `unity游戏开发`：在 PTC 全套工具之外接入 Unity 编辑器，编辑器重启也不会丢连接。

## 安装

前置条件，每位安装者自己的机器：

- DSH 版本满足 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.1 <0.2.3-0`）；不符时安装阶段被拒。
- 仓库访问沿用本机 GitHub 登录状态：安装框没有密码输入，没权限时直接失败。
- Unity 已安装并启动 [MCP for Unity](https://github.com/CoplayDev/unity-mcp)，服务监听 `127.0.0.1:8080`。这是编辑器侧的上游服务器，不随本包分发；没启动也能安装、开对话，只是调用工具会报「编辑器未连接」。

步骤：

1. 打开 **添加插件**，填仓库地址并带版本标签：

   ```
   https://github.com/U0Pin/dsh-unity-mcp-client#v1.1.1
   ```

   安装器解析不了时改用 `git+https://github.com/U0Pin/dsh-unity-mcp-client.git#v1.1.1`。
2. 新建对话时在模式列表选 `unity游戏开发`。模式在对话开始后不能更换。

## 使用

- 只有这个模式带 Unity 工具（`mcp__unity__*`）；`standard`/`ptc`/`minimal`/`cordis` 模式不受影响。
- 默认可见 `core` 分组的 30 个工具。需要别的分组时让 agent 用 `manage_tools` 打开；全部分组共 49 个，服务器新增的工具会自动出现，不用重启。
- 工具依赖编辑器：编辑器关着时调用会明确报「Unity 编辑器未连接」，工具本身不掉，编辑器打开后自动可用。
- 同时开着多个 Unity 对话时它们共享分组设置；编辑器重启后分组回到默认的 `core`。
- 桥接进程跟着 DSH 走，同一个端口只会有一个实例，多个窗口共用。

## 升级与卸载

- 第三方 bundle 不自动更新：升级 = 卸载后按新标签重装。
- 不填标签装到的是默认分支最新提交，没有可回退的版本；请始终带标签安装。
- 卸载：插件管理里 `remove_bundle`，目标 `dsh-unity-game-mode`。

## 出问题时

1. 确认 Unity 里 `Window > MCP for Unity` 已启动，服务在 `127.0.0.1:8080`。
2. 看桥接自身状态：

   ```
   curl http://127.0.0.1:18080/health
   ```

   `upstream.connected` 为 `false` 表示还没连上编辑器。
3. 仍无头绪：把 `unity-mcp-bridge:` 开头的 Host 日志行交给维护者。

开发、维护和发版相关信息见 [DEVELOPMENT.md](DEVELOPMENT.md)。

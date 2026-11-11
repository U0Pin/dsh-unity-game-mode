# Unity 游戏开发模式（DSH 插件）

装上它，DSH（DeepSeek Harness）的对话模式里会多一个 `unity游戏开发`。选这个模式开对话，AI 就能直接查看、修改、测试你的 Unity 工程，不你手动复制粘贴文件

## 开始之前

需要三样东西，缺一样都跑不起来：

1. **DSH**：装好，并能正常开对话。
2. **Unity**：装好编辑器，要用的工程能正常打开。
3. **MCP for Unity**：让 DSH 和 Unity 通信的配套插件，和 Unity 工程一起用。按[官方说明](https://github.com/CoplayDev/unity-mcp)装好，在 Unity 里打开菜单 `Window > MCP for Unity`，把服务启动起来并保持运行。

## 安装

1. 在 DSH 里打开 **插件→添加插件**。
2. 填入这个仓库地址（末尾的 `#v0.1.1` 是版本号，不要漏掉）：

   ```
   https://github.com/U0Pin/dsh-unity-game-mode#v0.1.1
   ```

   填了没反应或报错时，换成下面这个地址再试一次：

   ```
   git+https://github.com/U0Pin/dsh-unity-game-mode.git#v0.1.1
   ```
3. 新建一个对话，在模式列表里选 `unity游戏开发`。模式在新建对话时选定，之后不能改；选错了新开一个对话即可。

## 使用

- 在工作区使用`unity游戏开发`模式新建对话，直接说需求就行，比如「给 Player 加一个二段跳」「把这个场景的灯光调暗」，AI会自己调用工具进行操作。
- **一定要启动mcp的服务端！**Unity MCP 服务未启动时 ，AI调用工具会报错 。把 Unity 打开、在 `Window > MCP for Unity` 里启动服务，再让它重试即可，不用重开对话。
- 插件会在本机 `127.0.0.1:18080` 上开一个桥接服务，只监听本机、外部访问不到。DSH 通过它连 Unity 的 MCP 服务器，所以 Unity 关掉之后工具还在、重新打开编辑器也不用重开对话。

## 升级与卸载

- 插件不会自动更新。升级 = 先在插件管理里移除旧版，再用新版本号装一次（把地址里的 `#v0.1.1` 换成新版本号）。
- 卸载：插件管理里移除 `dsh-unity-game-mode`。

## 出问题时

- **安装时报错或被拒**：先确认这台机器能访问上面的 GitHub 地址，有仓库的访问权限，DSH 也升到最新；两样都正常还装不上，把报错发给维护者。
- **AI 调用工具一直报错**：确认 Unity 开着，并且 `Window > MCP for Unity` 里的服务是启动状态；改完重试，不用重开对话。
- **AI无法直接看到mcp工具**：确认当前对话是`unity游戏开发`模式
- **其它问题**：在 DSH 日志里找以 `unity-mcp-bridge:` 开头的行，连同现象一起发给维护者。

## 许可证

本仓库以 [MIT](LICENSE) 授权，版权归 U0Pin。

`cordis.patch.yml` 里的模式定义派生自 DeepSeek Harness 自带的 `ptc` 预设（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT，Copyright (c) 2026 DeepSeek），按同一许可使用。上游 [MCP for Unity](https://github.com/CoplayDev/unity-mcp) 以 MIT 授权，不随本包分发。

开发、维护和发版信息见 [DEVELOPMENT.md](DEVELOPMENT.md)。

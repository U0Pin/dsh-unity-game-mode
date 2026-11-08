# 变更记录

## 1.1.0 — 首个可分发版本

- 仓库根目录即插件包（原先在 `preset/` 子目录），可直接按 GitHub 仓库地址安装。
- 包名从 `@local/unity-game-mode` 改为 `dsh-unity-game-mode`；`cordis.patch.yml` 里的行引用同步更新。
- 补全可分发包元数据：显示名与说明（中/英）、图标导出、关键词、`files` 白名单。
- 声明适配的 DSH 版本（`engines.dsh: ">=0.2.2-rc.1 <0.2.3-0"`），版本不符时安装阶段即失败。
- 自检统一为 `npm test`。

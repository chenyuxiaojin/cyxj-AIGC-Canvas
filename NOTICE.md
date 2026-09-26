# 上游与第三方许可

本仓库基于 [tigerowo/infinite-canvas](https://github.com/tigerowo/infinite-canvas)，继续使用根目录 [MIT](LICENSE)，保留 `Copyright (c) 2026 tigerowo`。分发代码或其重要部分时保留版权声明与许可全文；本分支不替换上游作者。

- `.agents/skills/frontend-design/` 保留随附的 [Apache-2.0 原文](.agents/skills/frontend-design/LICENSE.txt)，不改为本项目 MIT。
- `.agents/skills/vercel-react-best-practices/` 来自 [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices)，其 SKILL.md 声明 MIT、作者为 Vercel，metadata.json 署名 Vercel Engineering；保留原声明。来源记录在 skills-lock.json。
- 打包的 Node.js 使用 [NODE-LICENSE](desktop/src-tauri/resources/licenses/NODE-LICENSE)，保留其完整第三方许可；上游应用许可副本在同目录。
- `web/public/director/models/ue-mannequin-retopology` 模型来自 William Luque 的 Sketchfab 作品，随附 [模型说明](web/public/director/models/ue-mannequin-retopology.license.txt) 标为 Sketchfab Standard。模型不是 MIT；本次未验证原下载凭证及独立模型再分发权限，使用与分发须遵循其原条款。
- 接入的提示词仓库、图片、音视频、模型、字体、用户素材及第三方服务分别遵循其原有权利和条款，不由程序的 MIT 统一授权。

本说明不对 MIT 代码增加额外限制。

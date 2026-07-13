# Horizon Discuss（中文说明）

[English README](README.md) · 仓库：[github.com/Yancy-gate/obsidian-horizon-discuss](https://github.com/Yancy-gate/obsidian-horizon-discuss)

**桌面端专用** Obsidian 插件：绑定内参/简报笔记 → AI 讨论 → 整理入库。

当前版本见 [Releases](https://github.com/Yancy-gate/obsidian-horizon-discuss/releases)。

---

## 功能概览

| 功能 | 说明 |
|------|------|
| 侧边栏聊天 | 绑定今日简报，结合摘录上下文回答 |
| AI 接口 | OpenCode Zen（首选）；无 Key 时回退 Copilot 插件 |
| 模型 | **无内置默认**，须在设置中自行填写 model id |
| 识图 | Ctrl+V 粘贴截图；拖入图片 |
| 附件 | 拖入 `.md` `.py` 等文本文件 |
| 网页 | [Agent Reach](https://github.com/Panniantong/Agent-Reach) 路由抓取（Jina / yt-dlp / bili-cli 等） |
| 入库 | 同一天多次入库 → **一个**晨读 + **一个** wiki + **一条**学习日志（追加章节，不重复建页） |
| Copilot | 可导入 `copilot-conversations` 导出 |

---

## 安装

### 方式一：安装包（推荐）

1. 打开 [Releases](https://github.com/Yancy-gate/obsidian-horizon-discuss/releases) 最新版
2. 下载 **`horizon-discuss-x.x.x.zip`**
3. 解压，将 **`horizon-discuss` 文件夹** 复制到：

   ```
   <你的库>/.obsidian/plugins/horizon-discuss/
   ```

4. 设置 → 社区插件 → 启用 **Horizon Discuss**
5. `Ctrl+P` → `Reload app without saving`

zip 内已含 `main.js`、`manifest.json`、`styles.css`、`agent-reach-fetch.py` 及 `INSTALL.md`。

### 方式二：手动挑选文件

从 Release 分别下载上述四个文件，放入同一文件夹 `horizon-discuss`。

### BRAT

添加：`Yancy-gate/obsidian-horizon-discuss`

---

## 首次配置（必做）

### 1. OpenCode Zen Key

安装 [OpenCode](https://opencode.ai/) 并登录。插件读取：

- Windows：`%USERPROFILE%\.local\share\opencode\auth.json` → `opencode.key`
- macOS/Linux：`~/.local/share/opencode/auth.json`

### 2. 模型（必填）

**设置 → Horizon Discuss**

| 项 | 必填 | 说明 |
|----|------|------|
| Default model | **是** | OpenCode Zen 的 model id |
| Vision model | 否 | 发图时用；留空则用 Default model |

插件**不预设**任何 model id。未配置时聊天会提示先填写。

查询可用 id：`GET https://opencode.ai/zen/v1/models`（需 Bearer Token）。

### 3. 路径与个性化

在设置 **Vault paths** 中修改，或编辑 `data.json`（升级不会覆盖）。

中文工作流示例：

```json
{
  "model": "你的-model-id",
  "visionModel": "你的识图-model-id",
  "briefingDir": "其他/内参日报",
  "dailyLogDir": "其他/每日自主学习",
  "wikiSessionsDir": "wiki/sessions",
  "briefingFilePrefix": "horizon-",
  "briefingFileSuffix": "-zh",
  "morningNotePrefix": "晨读-",
  "sessionNamePrefix": "启示-内参",
  "reviewLinks": "如何利用内参情报, _晨读模板",
  "focusTopics": "你的关注领域，逗号分隔"
}
```

---

## 使用流程

1. 打开面板 → **绑定今日内参**
2. 提问；可贴图、拖文件、粘贴 URL（自动抓取网页）
3. 或点 **抓取网页** 手动输入 URL
4. 勾选消息 → 选入库类型（理解/行动/判断）
5. **整理入库 → 晨读+Wiki**

---

## 入库规则（v0.6+）

同一天多次入库：

| 输出 | 规则 |
|------|------|
| 晨读 | `晨读-YYYY-MM-DD.md` 一个文件，按 `## Discussion · 标题` 分节 |
| Wiki | `{sessionPrefix}-YYYY-MM-DD.md` 一个文件，按 `## 标题` 分节 |
| 学习日志 | 当天日志里 **一条** `# N. Briefing discussion · 日期`，下挂 `### 标题` |
| 同标题再入库 | **更新**该节，不新建文件 |

---

## Agent Reach 网页抓取

需本机安装 Agent Reach（`pip install agent-reach` 或官方安装器）。插件调用同目录 `agent-reach-fetch.py`。

| 设置 | 默认 |
|------|------|
| Agent Reach Python | `~/.agent-reach-venv/Scripts/python.exe` |
| Auto-fetch URLs | 开 |
| Max web chars | 15000 |

---

## 故障排除

| 现象 | 处理 |
|------|------|
| `Failed to fetch` | 重载 Obsidian；检查模型已填、Zen Key、网络/代理 |
| 提示未配置模型 | 设置里填写 Default model |
| 识图差 | 换支持 vision 的 model id，或装 Copilot 作回退 |
| 更新后行为异常 | Reload app；检查 `data.json` |

---

## 隐私

- Key 仅存本机，无插件遥测
- 网页抓取经 Jina / 你本机 Agent Reach 工具链

## 许可

MIT — 见 [LICENSE](LICENSE)。

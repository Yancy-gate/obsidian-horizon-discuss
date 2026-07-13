# Horizon Discuss

**[中文说明 README.zh-CN.md](README.zh-CN.md)** · Desktop-only Obsidian plugin for briefing discussion + structured ingest.

Repository: [github.com/Yancy-gate/obsidian-horizon-discuss](https://github.com/Yancy-gate/obsidian-horizon-discuss) · [Releases](https://github.com/Yancy-gate/obsidian-horizon-discuss/releases)

Bind a daily briefing note → chat with AI (images, files, web pages) → ingest selected messages into morning notes, wiki sessions, and study logs.

---

## Features

| Feature | Description |
|---------|-------------|
| Side panel chat | Context from bound briefing excerpt |
| API | OpenCode Zen first; falls back to [Copilot](https://github.com/logancyang/obsidian-copilot) keys |
| Models | **No built-in default** — you must set model ids in settings |
| Vision | Paste screenshots (Ctrl+V); drag images |
| Files | Drag text files (`.md`, `.py`, …) into context |
| Web | [Agent Reach](https://github.com/Panniantong/Agent-Reach) routing via `agent-reach-fetch.py` |
| Ingest | **One** morning note + **one** wiki session + **one** log entry **per day**; multiple ingests append sections |
| Copilot import | Load recent `copilot-conversations` exports (optional) |

---

## Install

### Option A: Install zip (recommended)

1. Open [Releases](https://github.com/Yancy-gate/obsidian-horizon-discuss/releases) (latest)
2. Download **`horizon-discuss-x.x.x.zip`**
3. Unzip and copy the **`horizon-discuss`** folder to:

   ```
   <vault>/.obsidian/plugins/horizon-discuss/
   ```

4. Settings → Community plugins → enable **Horizon Discuss**
5. `Ctrl+P` → **Reload app without saving**

The zip includes `main.js`, `manifest.json`, `styles.css`, `agent-reach-fetch.py`, and `INSTALL.md`.

### Option B: Individual files

Download the four plugin files from the release assets into `.obsidian/plugins/horizon-discuss/`.

### BRAT

Add repository: `Yancy-gate/obsidian-horizon-discuss`

### Community plugins

Search **Horizon Discuss** after the plugin is approved in the directory.

---

## First-time setup (required)

### OpenCode Zen API key

Install [OpenCode](https://opencode.ai/) and sign in. The plugin reads `opencode.key` from:

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.local\share\opencode\auth.json` |
| macOS / Linux | `~/.local/share/opencode/auth.json` |

### Models (required)

**Settings → Horizon Discuss**

| Setting | Required | Notes |
|---------|----------|-------|
| **Default model** | **Yes** | OpenCode Zen model id for chat and ingest |
| **Vision model** | No | Used when images are attached; if empty, uses Default model |

The plugin ships with **empty** model fields. Chat will error until you configure a model id.

List ids: `GET https://opencode.ai/zen/v1/models` (Bearer token) or OpenCode docs.

### Vault paths

Generic defaults (change in settings or `data.json`):

| Setting | Default |
|---------|---------|
| Briefing folder | `Horizon/briefings` |
| Daily log folder | `Daily notes` |
| Wiki sessions | `wiki/sessions` |
| Briefing prefix / suffix | `horizon-` / `-zh` |
| Morning note prefix | `morning-` |
| Session prefix | `briefing-session` |

Example `data.json` snippet:

```json
{
  "model": "your-model-id",
  "visionModel": "your-vision-model-id",
  "briefingDir": "Horizon/briefings",
  "dailyLogDir": "Daily notes",
  "morningNotePrefix": "morning-",
  "sessionNamePrefix": "briefing-session",
  "focusTopics": "your learning goals"
}
```

`data.json` is local config and is not overwritten on plugin update.

---

## Daily workflow

1. Open panel → **绑定今日内参** (bind today's briefing)
2. Ask questions; paste images, drop files, or include URLs (auto-fetched)
3. Or click **抓取网页** to fetch a URL manually
4. Check messages → pick ingest type (理解 / 行动 / 判断)
5. **整理入库 → 晨读+Wiki**

---

## Ingest rules (v0.6+)

Multiple ingests on the **same calendar day**:

| Output | Behavior |
|--------|----------|
| Morning note | One file `{morningPrefix}YYYY-MM-DD.md`; sections `## Discussion · {title}` |
| Wiki session | One file `{sessionPrefix}-YYYY-MM-DD.md`; sections `## {title}` |
| Study log | One `# N. Briefing discussion · {date}` entry; subsections `### {title}` |
| Re-ingest same title | **Updates** that section — no duplicate pages |

---

## Agent Reach web fetch

Requires [Agent Reach](https://github.com/Panniantong/Agent-Reach) on the machine (optional but recommended for platform routing). The plugin runs `agent-reach-fetch.py` next to `main.js`.

| Route | Backend |
|-------|---------|
| General web | Jina Reader |
| YouTube | yt-dlp |
| Bilibili | bili-cli / OpenCLI |
| Twitter/X | OpenCLI / twitter-cli |
| RSS | feedparser |
| Fallback | Jina Reader |

Settings → **Agent Reach**: Python path, auto-fetch URLs (max 3 per message), max content length.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Failed to fetch` | Reload Obsidian; set Default model; check Zen key and network/proxy |
| Model not configured | Fill **Default model** in settings |
| Weak vision | Use a vision-capable model id, or install Copilot for SiliconFlow fallback |
| After update | Reload app; verify `data.json` |

---

## Development

No build step:

```bash
node --check main.js
```

---

## Privacy

- API keys stay on your device only
- No plugin telemetry
- Web fetch uses Jina Reader and/or local Agent Reach tools

## License

MIT — see [LICENSE](LICENSE).

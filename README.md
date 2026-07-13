# Horizon Discuss

Discuss daily briefing notes inside Obsidian with an AI assistant, then **ingest** selected messages into structured notes.

**Desktop only** (uses Node.js `fs` to read your local OpenCode Zen API key).

## Features

- Side panel chat bound to a **briefing note** (auto-detect latest by filename pattern).
- **OpenCode Zen** by default (`~/.local/share/opencode/auth.json`); falls back to the [Copilot](https://github.com/logancyang/obsidian-copilot) plugin API keys.
- **Vision**: paste screenshots (Ctrl+V) or drag images into the panel.
- **Attachments**: drag text files (`.md`, `.py`, …) into context.
- **Markdown rendering** for assistant replies.
- **Ingest** checked messages → one daily morning note + one wiki session + one study log entry (multiple ingests append sections, no duplicate pages).
- Import recent **Copilot** conversation exports (optional).
- Configurable vault paths, filename prefixes, review wikilinks, and AI focus topics.

## Install (manual)

1. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/horizon-discuss/`.
2. Enable **Horizon Discuss** in **Settings → Community plugins** (or reload plugins).
3. Open **Horizon Discuss** from the ribbon or command palette: `打开 Horizon 讨论入库面板`.

## Install (Community plugins)

Search **Horizon Discuss** in Obsidian **Settings → Community plugins → Browse** after the plugin is approved.

## Setup

### OpenCode Zen (recommended)

Install [OpenCode](https://opencode.ai/) and sign in. The plugin reads `opencode.key` from:

- Windows: `%USERPROFILE%\.local\share\opencode\auth.json`
- macOS/Linux: `~/.local/share/opencode/auth.json`

Default models: `claude-haiku-4-5` (fast, supports images). Change under **Settings → Horizon Discuss**.

### Vault paths

Defaults assume a generic layout:

| Setting | Default |
|---------|---------|
| Briefing folder | `Horizon/briefings` |
| Daily log folder | `Daily notes` |
| Wiki sessions | `wiki/sessions` |
| Briefing prefix / suffix | `horizon-` / `-zh` |
| Morning note prefix | `morning-` |
| Session prefix | `briefing-session` |

Adjust all paths in **Settings → Horizon Discuss → Vault paths**.

### Example: Chinese briefing workflow

```json
{
  "briefingDir": "其他/内参日报",
  "dailyLogDir": "其他/每日自主学习",
  "morningNotePrefix": "晨读-",
  "sessionNamePrefix": "启示-内参",
  "reviewLinks": "如何利用内参情报, _晨读模板",
  "focusTopics": "your topics here"
}
```

Paste into `.obsidian/plugins/horizon-discuss/data.json` or use the settings UI.

## Usage

1. **绑定今日内参** — bind today's briefing (or pick a file).
2. Chat; paste images or drop files as needed.
3. Check messages to keep, choose card type (理解 / 行动 / 判断).
4. **整理入库 → 晨读+Wiki** — writes morning note, wiki session, and daily log entry.

## Development

No build step: `main.js` is the release artifact. Validate syntax:

```bash
node --check main.js
```

## License

MIT — see [LICENSE](LICENSE).

## Privacy

- API keys stay on your machine (OpenCode auth file or Copilot plugin settings).
- No telemetry or external servers except your chosen LLM provider.

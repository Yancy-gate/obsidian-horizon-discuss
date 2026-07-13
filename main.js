const { Plugin, ItemView, WorkspaceLeaf, Notice, Modal, Setting, MarkdownRenderer, PluginSettingTab } = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VIEW_TYPE = "horizon-discuss-view";
const COPILOT_DATA = ".obsidian/plugins/copilot/data.json";
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const TEXT_EXTS = new Set([
  "md", "txt", "json", "csv", "tsv", "py", "js", "ts", "tsx", "jsx", "c", "cpp", "h", "hpp",
  "java", "go", "rs", "rb", "php", "html", "css", "scss", "xml", "yaml", "yml", "toml",
  "ini", "log", "sh", "ps1", "bat", "sql", "r", "m", "tex", "bib", "org",
]);
const MAX_PENDING_IMAGES = 4;
const MAX_PENDING_FILES = 6;
const MAX_FILE_CHARS = 12000;
const MAX_IMAGE_SIDE = 1280;
const IMAGE_JPEG_QUALITY = 0.85;

// OpenCode Zen：chat/completions 可用；claude-haiku 实测支持识图且较快
const OPENCODE_ZEN_BASE = "https://opencode.ai/zen/v1";
const OPENCODE_DEFAULT_MODEL = "claude-haiku-4-5";
const OPENCODE_VISION_MODEL = "claude-haiku-4-5";
const SILICONFLOW_VISION_FALLBACK = [
  "zai-org/GLM-5V-Turbo",
  "Qwen/Qwen3-VL-32B-Instruct",
];

const DEFAULT_SETTINGS = {
  provider: "opencode-zen",
  model: OPENCODE_DEFAULT_MODEL,
  visionModel: OPENCODE_VISION_MODEL,
  briefingDir: "Horizon/briefings",
  dailyLogDir: "Daily notes",
  wikiSessionsDir: "wiki/sessions",
  copilotConvDir: "copilot/copilot-conversations",
  briefingFilePrefix: "horizon-",
  briefingFileSuffix: "-zh",
  morningNotePrefix: "morning-",
  sessionNamePrefix: "briefing-session",
  reviewLinks: "",
  dailyLogIntro: "> Review entries from Horizon Discuss.\n\n",
  focusTopics: "your learning goals and current projects",
};

function resolveSettings(raw) {
  return Object.assign({}, DEFAULT_SETTINGS, raw || {});
}

function reviewLinkLines(settings) {
  const links = String(settings.reviewLinks || "")
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return links.map((l) => `- [[${l}]]`).join("\n");
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(s, n = 500) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function looksLikeVisionModel(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  return (
    n.includes("-vl") ||
    n.includes("vl-") ||
    n.includes("vision") ||
    n.includes("gpt-4o") ||
    n.includes("gpt-5") ||
    n.includes("gemini") ||
    n.includes("claude") ||
    /glm-\d*v/i.test(n) ||
    n.includes("5v")
  );
}

function nextDailyEntryNumber(text) {
  let max = 0;
  const re = /^#\s+(\d+)\./gm;
  let m;
  while ((m = re.exec(text || ""))) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

function extractKeyPointsTable(organized) {
  const lines = (organized || "").split("\n");
  const bullets = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\[.\]\s*(.+)$/) || line.match(/^\s*[-*]\s+(.+)$/);
    if (m) bullets.push(m[1].replace(/\*\*/g, "").trim());
    if (bullets.length >= 5) break;
  }
  if (!bullets.length) {
    const understand = organized.match(/##\s*我的理解\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (understand) {
      const t = understand[1].replace(/\s+/g, " ").trim().slice(0, 120);
      if (t) bullets.push(t);
    }
  }
  if (!bullets.length) bullets.push("See session body");
  return bullets.map((b, i) => `| ${i === 0 ? "Point" : "Extra"}${i + 1} | ${b.slice(0, 80)} |`).join("\n");
}

function readOpenCodeZenKey() {
  const candidates = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), "AppData", "Roaming", "opencode", "auth.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p);
      const text = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.slice(3).toString("utf8") : raw.toString("utf8");
      const data = JSON.parse(text);
      const key = data?.opencode?.key;
      if (typeof key === "string" && key.length > 8) return { key, path: p };
    } catch (e) {
      console.error("read OpenCode auth failed", p, e);
    }
  }
  return null;
}

function extOfName(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return IMAGE_EXTS.has(extOfName(file.name));
}

function isTextFile(file) {
  if (!file) return false;
  if (file.type && (file.type.startsWith("text/") || file.type === "application/json")) return true;
  return TEXT_EXTS.has(extOfName(file.name));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
}

async function compressDataUrl(dataUrl, maxSide = MAX_IMAGE_SIDE, quality = IMAGE_JPEG_QUALITY) {
  const img = await loadImageElement(dataUrl);
  let { width, height } = img;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  // 统一转 JPEG，减小 payload；保留透明图时用 PNG
  const isPng = /^data:image\/png/i.test(dataUrl);
  if (isPng && quality >= 0.95) {
    return { dataUrl: canvas.toDataURL("image/png"), mime: "image/png" };
  }
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), mime: "image/jpeg" };
}

async function arrayBufferToCompressedDataUrl(buf, extHint) {
  const mimeGuess =
    extHint === "png"
      ? "image/png"
      : extHint === "webp"
        ? "image/webp"
        : extHint === "gif"
          ? "image/gif"
          : "image/jpeg";
  const blob = new Blob([buf], { type: mimeGuess });
  const rawUrl = await fileToDataUrl(blob);
  return compressDataUrl(rawUrl);
}

function messageToApiContent(m, includeImages) {
  let text = (m.content || "").trim() || (includeImages && m.images?.length ? "（见附图）" : "");
  if (m.files?.length) {
    const blocks = m.files
      .map((f) => `\n\n---\n附件文件：${f.name}\n\`\`\`\n${truncate(f.text || "", MAX_FILE_CHARS)}\n\`\`\``)
      .join("");
    text = (text || "请结合下列附件回答") + blocks;
  }
  const images = includeImages ? m.images || [] : [];
  if (!images.length) return text;

  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({
      type: "image_url",
      image_url: { url: img.dataUrl },
    });
  }
  return parts;
}

function buildApiMessages(system, historyMessages) {
  const out = [{ role: "system", content: system }];
  const list = historyMessages.filter((m) => m.role === "user" || m.role === "assistant").slice(-12);
  // 只给最近 2 条带图的用户消息附上图片，避免超大请求
  let imageSlots = 2;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const hasImg = m.role === "user" && m.images && m.images.length;
    const includeImages = !!(hasImg && imageSlots > 0);
    if (includeImages) imageSlots -= 1;
    list[i] = { ...m, _includeImages: includeImages };
  }
  for (const m of list) {
    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: messageToApiContent(m, !!m._includeImages),
    });
  }
  return out;
}

class HorizonDiscussView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.pendingImages = [];
    this.pendingFiles = [];
    this.briefingPath = null;
    this.briefingExcerpt = "";
    this.statusEl = null;
    this.listEl = null;
    this.inputEl = null;
    this.typeEl = null;
    this.pendingEl = null;
    this.composerEl = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Horizon 讨论";
  }

  getIcon() {
    return "messages-square";
  }

  paths() {
    const s = resolveSettings(this.plugin.settings);
    return {
      briefingDir: s.briefingDir,
      dailyLogDir: s.dailyLogDir,
      wikiSessionsDir: s.wikiSessionsDir,
      copilotConvDir: s.copilotConvDir,
      briefingFilePrefix: s.briefingFilePrefix,
      briefingFileSuffix: s.briefingFileSuffix,
      morningNotePrefix: s.morningNotePrefix,
      sessionNamePrefix: s.sessionNamePrefix,
      reviewLinks: s.reviewLinks,
      dailyLogIntro: s.dailyLogIntro,
    };
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("horizon-discuss-view");

    const header = root.createDiv({ cls: "hd-header" });
    this.briefingLabel = header.createDiv({ cls: "hd-briefing" });
    const row1 = header.createDiv({ cls: "hd-row" });
    const bindBtn = row1.createEl("button", { text: "绑定今日内参" });
    bindBtn.onclick = () => this.bindTodayBriefing();
    const pickBtn = row1.createEl("button", { text: "选择内参文件" });
    pickBtn.onclick = () => this.pickBriefingFile();
    const importBtn = row1.createEl("button", { text: "导入 Copilot 会话" });
    importBtn.onclick = () => this.importCopilotConversation();

    const row2 = header.createDiv({ cls: "hd-row" });
    row2.createSpan({ cls: "hd-label", text: "入库类型" });
    this.typeEl = row2.createEl("select", { cls: "hd-type" });
    for (const [v, t] of [
      ["understand", "理解卡"],
      ["action", "行动卡"],
      ["judgment", "判断卡"],
    ]) {
      this.typeEl.createEl("option", { text: t, value: v });
    }

    this.listEl = root.createDiv({ cls: "hd-messages" });

    const composer = root.createDiv({ cls: "hd-composer" });
    this.composerEl = composer;
    this.pendingEl = composer.createDiv({ cls: "hd-pending" });

    this.inputEl = composer.createEl("textarea", {
      cls: "hd-input",
      attr: {
        placeholder:
          "围绕今日内参提问…（Ctrl+V 粘贴截图；可从文件管理器拖入图片/文本；Enter 发送，Shift+Enter 换行）",
      },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.inputEl.addEventListener("paste", (e) => this.handlePaste(e));

    for (const el of [composer, this.inputEl]) {
      el.addEventListener("dragover", (e) => this.handleDragOver(e));
      el.addEventListener("dragleave", (e) => this.handleDragLeave(e));
      el.addEventListener("drop", (e) => this.handleDrop(e));
    }

    const actions = composer.createDiv({ cls: "hd-actions" });
    const sendBtn = actions.createEl("button", { text: "发送", cls: "mod-cta" });
    sendBtn.onclick = () => this.sendMessage();
    const selectAll = actions.createEl("button", { text: "全选" });
    selectAll.onclick = () => this.setAllSelected(true);
    const clearSel = actions.createEl("button", { text: "取消勾选" });
    clearSel.onclick = () => this.setAllSelected(false);
    const ingestBtn = actions.createEl("button", { text: "整理入库 → 晨读+Wiki", cls: "mod-cta" });
    ingestBtn.onclick = () => this.ingestSelected();
    const clearChat = actions.createEl("button", { text: "清空对话" });
    clearChat.onclick = () => {
      this.messages = [];
      this.pendingImages = [];
      this.pendingFiles = [];
      this.renderPending();
      this.renderMessages();
    };

    this.statusEl = root.createDiv({ cls: "hd-status" });
    await this.bindTodayBriefing(true);
    this.renderPending();
    this.renderMessages();
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text || "");
  }

  renderPending() {
    if (!this.pendingEl) return;
    this.pendingEl.empty();
    if (!this.pendingImages.length && !this.pendingFiles.length) return;

    const parts = [];
    if (this.pendingImages.length) parts.push(`${this.pendingImages.length} 图`);
    if (this.pendingFiles.length) parts.push(`${this.pendingFiles.length} 文件`);
    this.pendingEl.createSpan({ cls: "hd-label", text: `待发送：${parts.join(" · ")}` });

    if (this.pendingImages.length) {
      const row = this.pendingEl.createDiv({ cls: "hd-pending-row" });
      for (const img of this.pendingImages) {
        const wrap = row.createDiv({ cls: "hd-thumb-wrap" });
        wrap.createEl("img", {
          cls: "hd-thumb",
          attr: { src: img.dataUrl, alt: img.name || "image", title: img.name || "image" },
        });
        const rm = wrap.createEl("button", { text: "×", cls: "hd-thumb-remove" });
        rm.onclick = () => {
          this.pendingImages = this.pendingImages.filter((x) => x.id !== img.id);
          this.renderPending();
        };
      }
    }

    if (this.pendingFiles.length) {
      const row = this.pendingEl.createDiv({ cls: "hd-pending-files" });
      for (const f of this.pendingFiles) {
        const chip = row.createDiv({ cls: "hd-file-chip" });
        chip.createSpan({ cls: "hd-file-name", text: f.name });
        const rm = chip.createEl("button", { text: "×", cls: "hd-file-remove" });
        rm.onclick = () => {
          this.pendingFiles = this.pendingFiles.filter((x) => x.id !== f.id);
          this.renderPending();
        };
      }
    }
  }

  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    this.composerEl?.addClass("hd-drag-over");
  }

  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    if (this.composerEl && !this.composerEl.contains(e.relatedTarget)) {
      this.composerEl.removeClass("hd-drag-over");
    }
  }

  async handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.composerEl?.removeClass("hd-drag-over");

    const dt = e.dataTransfer;
    if (!dt) return;

    const files = Array.from(dt.files || []);
    if (files.length) {
      for (const f of files) await this.addDroppedFile(f);
      return;
    }

    const plain = dt.getData("text/plain") || dt.getData("text/uri-list") || "";
    const paths = plain
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/^file:\/\//i, ""))
      .filter(Boolean);
    for (const p of paths) await this.tryAddVaultOrPath(p);
  }

  async handlePaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;

    const fileList = Array.from(dt.files || []);
    const imageFiles = fileList.filter((f) => isImageFile(f));
    if (imageFiles.length) {
      e.preventDefault();
      for (const f of imageFiles) await this.addImageFile(f);
      return;
    }

    const items = Array.from(dt.items || []);
    const imageItems = items.filter((it) => it.type && it.type.startsWith("image/"));
    if (imageItems.length) {
      e.preventDefault();
      for (const it of imageItems) {
        const file = it.getAsFile();
        if (file) await this.addImageFile(file);
      }
    }
  }

  async addDroppedFile(file) {
    if (!file) return;
    if (isImageFile(file)) {
      await this.addImageFile(file);
      return;
    }
    if (isTextFile(file)) {
      await this.addTextContextFile(file.name, await readFileAsText(file));
      return;
    }
    new Notice(`暂不支持：${file.name}（可拖入图片或 .md/.txt/.py 等文本）`);
  }

  async tryAddVaultOrPath(rawPath) {
    const norm = decodeURIComponent(String(rawPath || "")).replace(/\\/g, "/").trim();
    if (!norm) return;

    const vaultFiles = this.app.vault.getFiles();
    let match =
      vaultFiles.find((f) => f.path === norm) ||
      vaultFiles.find((f) => norm.endsWith("/" + f.path) || norm.endsWith(f.path));

    if (!match && fs.existsSync(norm)) {
      const base = path.basename(norm);
      const ext = extOfName(base);
      if (IMAGE_EXTS.has(ext)) {
        const buf = fs.readFileSync(norm);
        const compressed = await arrayBufferToCompressedDataUrl(buf, ext);
        if (this.pendingImages.length >= MAX_PENDING_IMAGES) {
          new Notice(`一次最多 ${MAX_PENDING_IMAGES} 张图`);
          return;
        }
        this.pendingImages.push({
          id: uid(),
          name: base,
          path: norm,
          mime: compressed.mime,
          dataUrl: compressed.dataUrl,
        });
        this.renderPending();
        this.setStatus(`已拖入：${base}`);
        return;
      }
      if (TEXT_EXTS.has(ext)) {
        const text = fs.readFileSync(norm, "utf8");
        await this.addTextContextFile(base, text, norm);
        return;
      }
    }

    if (!match) {
      new Notice(`未识别附件：${norm}`);
      return;
    }

    const ext = (match.extension || "").toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      if (this.pendingImages.length >= MAX_PENDING_IMAGES) {
        new Notice(`一次最多 ${MAX_PENDING_IMAGES} 张图`);
        return;
      }
      const buf = await this.app.vault.readBinary(match);
      const compressed = await arrayBufferToCompressedDataUrl(buf, ext);
      this.pendingImages.push({
        id: uid(),
        name: match.name,
        path: match.path,
        mime: compressed.mime,
        dataUrl: compressed.dataUrl,
      });
      this.renderPending();
      this.setStatus(`已拖入：${match.path}`);
      return;
    }

    const text = await this.app.vault.read(match);
    await this.addTextContextFile(match.name, text, match.path);
  }

  async addTextContextFile(name, text, pathHint) {
    if (this.pendingFiles.length >= MAX_PENDING_FILES) {
      new Notice(`一次最多 ${MAX_PENDING_FILES} 个附件`);
      return;
    }
    const trimmed = String(text || "").slice(0, MAX_FILE_CHARS);
    if (!trimmed.trim()) {
      new Notice(`${name} 为空或无法读取`);
      return;
    }
    if (this.pendingFiles.some((f) => f.name === name && f.path === pathHint)) {
      new Notice(`已添加：${name}`);
      return;
    }
    this.pendingFiles.push({
      id: uid(),
      name,
      path: pathHint || "",
      text: trimmed,
    });
    this.renderPending();
    this.setStatus(`已附加：${name}`);
  }

  async addImageFile(file) {
    if (!file || !isImageFile(file)) {
      new Notice("仅支持图片文件");
      return;
    }
    if (this.pendingImages.length >= MAX_PENDING_IMAGES) {
      new Notice(`一次最多 ${MAX_PENDING_IMAGES} 张图`);
      return;
    }
    try {
      this.setStatus("压缩图片中…");
      const raw = await fileToDataUrl(file);
      const compressed = await compressDataUrl(raw);
      this.pendingImages.push({
        id: uid(),
        name: file.name || `paste-${Date.now()}.jpg`,
        mime: compressed.mime,
        dataUrl: compressed.dataUrl,
      });
      this.renderPending();
      this.setStatus(`已粘贴图片（${this.pendingImages.length}）`);
    } catch (err) {
      console.error(err);
      new Notice(`添加图片失败：${err.message || err}`);
      this.setStatus("添加图片失败");
    }
  }

  async bindTodayBriefing(silent = false) {
    const p = this.paths();
    const today = todayStr();
    const candidates = [
      `${p.briefingDir}/${p.briefingFilePrefix}${today}${p.briefingFileSuffix}.md`,
      `${p.briefingDir}/${p.briefingFilePrefix}${todayStrOffset(-1)}${p.briefingFileSuffix}.md`,
    ];
    let found = null;
    for (const candidate of candidates) {
      if (await this.app.vault.adapter.exists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter(
          (f) =>
            f.path.includes(p.briefingDir) &&
            f.basename.startsWith(p.briefingFilePrefix) &&
            f.basename.endsWith(p.briefingFileSuffix)
        )
        .sort((a, b) => b.basename.localeCompare(a.basename));
      if (files[0]) found = files[0].path;
    }
    if (!found) {
      this.briefingPath = null;
      this.briefingLabel.setText("未找到内参日报，请手动选择");
      if (!silent) new Notice("未找到内参日报");
      return;
    }
    await this.loadBriefing(found);
    if (!silent) new Notice(`已绑定：${found}`);
  }

  async pickBriefingFile() {
    const p = this.paths();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.includes(p.briefingDir) && f.basename.startsWith(p.briefingFilePrefix))
      .sort((a, b) => b.basename.localeCompare(a.basename))
      .slice(0, 30);
    if (!files.length) {
      new Notice("内参目录为空");
      return;
    }
    const modal = new FilePickModal(this.app, files, async (file) => {
      await this.loadBriefing(file.path);
      new Notice(`已绑定：${file.path}`);
    });
    modal.open();
  }

  async loadBriefing(path) {
    this.briefingPath = path;
    const content = await this.app.vault.adapter.read(path);
    this.briefingExcerpt = content.slice(0, 12000);
    this.briefingLabel.setText(`内参：${path}`);
  }

  async importCopilotConversation() {
    const p = this.paths();
    const folder = this.app.vault.getAbstractFileByPath(p.copilotConvDir);
    if (!folder || !folder.children) {
      new Notice(`找不到 ${p.copilotConvDir}`);
      return;
    }
    const files = folder.children
      .filter((f) => f.extension === "md")
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 40);
    if (!files.length) {
      new Notice("暂无 Copilot 会话文件");
      return;
    }
    const modal = new FilePickModal(this.app, files, async (file) => {
      const text = await this.app.vault.read(file);
      const parsed = parseCopilotConversation(text);
      if (!parsed.length) {
        new Notice("未能解析会话内容");
        return;
      }
      for (const m of parsed) {
        this.messages.push({
          id: uid(),
          role: m.role,
          content: m.content,
          images: [],
          files: [],
          selected: m.role === "assistant" || m.role === "ai" ? true : false,
        });
      }
      this.renderMessages();
      new Notice(`已导入 ${parsed.length} 条消息（可勾选后入库）`);
    });
    modal.open();
  }

  setAllSelected(v) {
    for (const m of this.messages) m.selected = v;
    this.renderMessages();
  }

  async renderMessages() {
    this.listEl.empty();
    if (!this.messages.length) {
      this.listEl.createDiv({
        cls: "hd-label",
        text: "尚无消息。先绑定内参，再提问；可 Ctrl+V 粘贴截图，或拖入图片/文本文件。",
      });
      return;
    }

    const sourcePath = this.briefingPath || "";
    for (const m of this.messages) {
      const card = this.listEl.createDiv({ cls: "hd-msg" + (m.selected ? " selected" : "") });
      const top = card.createDiv({ cls: "hd-msg-top" });
      const cb = top.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = !!m.selected;
      cb.onchange = () => {
        m.selected = cb.checked;
        card.toggleClass("selected", m.selected);
      };
      top.createSpan({
        cls: "hd-msg-role",
        text: m.role === "user" ? "你" : "AI",
      });
      if (m.images?.length) {
        top.createSpan({ cls: "hd-msg-badge", text: `${m.images.length} 图` });
      }
      if (m.files?.length) {
        top.createSpan({ cls: "hd-msg-badge", text: `${m.files.length} 附件` });
      }
      if (m.content) {
        const body = card.createDiv({
          cls: "hd-msg-body markdown-rendered" + (m.role === "assistant" ? " hd-msg-ai" : " hd-msg-user"),
        });
        try {
          await MarkdownRenderer.render(this.app, m.content, body, sourcePath, this);
        } catch (err) {
          console.error(err);
          body.createDiv({ text: m.content });
        }
      }
      if (m.images?.length) {
        const row = card.createDiv({ cls: "hd-msg-images" });
        for (const img of m.images) {
          row.createEl("img", {
            cls: "hd-thumb",
            attr: { src: img.dataUrl, alt: img.name || "image", title: img.name || img.path || "" },
          });
        }
      }
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  async sendMessage() {
    const text = (this.inputEl.value || "").trim();
    const images = this.pendingImages.slice();
    const files = this.pendingFiles.slice();
    if (!text && !images.length && !files.length) return;
    if (!this.briefingPath) {
      new Notice("请先绑定今日内参");
      return;
    }

    const parts = [];
    if (images.length) parts.push(`${images.length} 张图`);
    if (files.length) parts.push(`${files.length} 个附件`);
    const focus = this.plugin.settings.focusTopics || DEFAULT_SETTINGS.focusTopics;
    const userText =
      text ||
      (parts.length
        ? `请结合今日内参与${parts.join("、")}回答：说明关键信息、与主线（${focus}）的关联、可行动下一步。`
        : "");

    this.inputEl.value = "";
    this.pendingImages = [];
    this.pendingFiles = [];
    this.renderPending();

    this.messages.push({
      id: uid(),
      role: "user",
      content: userText,
      images,
      files,
      selected: true,
    });
    await this.renderMessages();
    this.setStatus(images.length ? "识图思考中…" : "思考中…");

    try {
      const creds = await this.plugin.loadCredentials({ needVision: images.length > 0 });
      const system = buildChatSystem(
        this.briefingPath,
        this.briefingExcerpt,
        this.plugin.settings.focusTopics
      );
      const apiMessages = buildApiMessages(system, this.messages);
      const reply = await chatCompletion(creds, apiMessages, { maxTokens: 2048 });
      this.messages.push({ id: uid(), role: "assistant", content: reply, images: [], selected: true });
      await this.renderMessages();
      this.setStatus(`就绪 · ${creds.providerLabel} / ${creds.model}`);
    } catch (e) {
      console.error(e);
      this.setStatus("发送失败");
      new Notice(`聊天失败：${e.message || e}`);
    }
  }

  async ingestSelected() {
    const selected = this.messages.filter((m) => m.selected);
    if (!selected.length) {
      new Notice("请先勾选要入库的对话");
      return;
    }
    if (!this.briefingPath) {
      new Notice("请先绑定内参日报");
      return;
    }
    this.setStatus("正在整理入库…");
    try {
      const hasImages = selected.some((m) => m.images?.length);
      const creds = await this.plugin.loadCredentials({ needVision: hasImages });
      const type = this.typeEl.value;
      const typeLabel = { understand: "理解卡", action: "行动卡", judgment: "判断卡" }[type];
      const discussText = selected
        .map((m) => {
          const imgNote = m.images?.length
            ? `\n（附图 ${m.images.length} 张：${m.images.map((i) => i.name || i.path || "image").join("、")}）`
            : "";
          const fileNote = m.files?.length
            ? `\n（附件：${m.files.map((f) => f.name || f.path || "file").join("、")}）`
            : "";
          return `【${m.role === "user" ? "用户" : "AI"}】\n${m.content || ""}${imgNote}${fileNote}`;
        })
        .join("\n\n---\n\n");

      const focus = this.plugin.settings.focusTopics || DEFAULT_SETTINGS.focusTopics;
      const prompt = `你是 Obsidian 知识库整理助手。根据「今日内参摘录」和「用户勾选的讨论」，输出一份可直接入库的中文笔记。

要求：
1. 只输出 Markdown，不要代码围栏包裹全文
2. 结构必须包含以下标题：
# （简洁标题，≤20字）
## 来源
## 发生了什么
## 我的理解
## 未决问题
## 下一步
3. 「我的理解」优先保留用户原话与判断，不要空话；全文偏短、利于复习
4. 「下一步」用 - [ ] 清单，最多 5 条
5. 类型提示：这是「${typeLabel}」
6. 若与用户关注领域（${focus}）相关，在理解里点明连接
7. 若讨论涉及图片，在「发生了什么/我的理解」里概括图中关键信息（不要编造看不见的细节）

今日内参路径：${this.briefingPath}

内参摘录：
${this.briefingExcerpt.slice(0, 8000)}

勾选的讨论：
${discussText.slice(0, 10000)}
`;

      // 入库整理：把最近带图用户消息一并送给模型，便于保留识图结论
      const ingestMessages = [
        { role: "system", content: "你输出干净的 Markdown 笔记，服从用户结构要求。" },
      ];
      const lastImgMsg = [...selected].reverse().find((m) => m.role === "user" && m.images?.length);
      if (lastImgMsg) {
        ingestMessages.push({
          role: "user",
          content: messageToApiContent(
            {
              content: prompt,
              images: lastImgMsg.images.slice(0, 2),
            },
            true
          ),
        });
      } else {
        ingestMessages.push({ role: "user", content: prompt });
      }

      const organized = await chatCompletion(creds, ingestMessages, { maxTokens: 3000 });

      const paths = await this.plugin.writeIngestResults({
        organized,
        type,
        typeLabel,
        briefingPath: this.briefingPath,
        discussText,
      });

      this.setStatus(`已入库：${paths.wiki}`);
      new Notice(`已写入晨读 + wiki + 每日日志`);
    } catch (e) {
      console.error(e);
      this.setStatus("入库失败");
      new Notice(`入库失败：${e.message || e}`);
    }
  }
}

function todayStrOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function buildChatSystem(briefingPath, excerpt, focusTopics) {
  const focus = focusTopics || DEFAULT_SETTINGS.focusTopics;
  return `你是用户的学习搭档。用户正在阅读 Horizon 内参日报（${briefingPath}）。
关注领域：${focus}

回答风格（必须遵守）：
1. 先用 1–2 句说清「这是什么 / 为什么重要」
2. 再给 2–4 个短要点；少套话、少形容词堆砌
3. 难概念用生活类比；术语首次出现可括号简释
4. 不确定就明说；不要编造
5. 有附图时：先说图中可见信息，再联系内参；不臆造看不见的细节
6. 默认用简洁 Markdown（小标题 / 列表 / 加粗 sparingly）

内参摘录（可能截断）：
${excerpt.slice(0, 5000)}`;
}

function parseCopilotConversation(text) {
  const body = text.replace(/^---[\s\S]*?---\s*/, "");
  const parts = body.split(/\n(?=\*\*(?:user|ai|assistant)\*\*:)/i);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^\*\*(user|ai|assistant)\*\*:\s*([\s\S]*)$/i);
    if (!m) continue;
    let content = m[2].trim();
    content = content.replace(/\n\[Context:[\s\S]*?\]\s*$/g, "").replace(/\n\[Timestamp:[\s\S]*?\]\s*$/g, "").trim();
    if (!content) continue;
    const role = m[1].toLowerCase() === "user" ? "user" : "assistant";
    out.push({ role, content });
  }
  return out;
}

async function chatCompletion(creds, messages, opts = {}) {
  const url = `${creds.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({
      model: creds.model,
      messages,
      temperature: 0.25,
      max_tokens: opts.maxTokens || 2048,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${res.status} ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回为空");
  return typeof content === "string" ? content.trim() : JSON.stringify(content);
}

class FilePickModal extends Modal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "选择文件" });
    for (const f of this.files) {
      const btn = contentEl.createEl("button", {
        text: f.path || f.basename || f.name,
        cls: "mod-cta",
      });
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.marginBottom = "6px";
      btn.onclick = async () => {
        this.close();
        await this.onChoose(f);
      };
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}

class HorizonDiscussPlugin extends Plugin {
  async onload() {
    this.settings = resolveSettings(await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new HorizonDiscussView(leaf, this));

    this.addRibbonIcon("messages-square", "Horizon 讨论入库", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-horizon-discuss",
      name: "打开 Horizon 讨论入库面板",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "horizon-bind-today",
      name: "Horizon：绑定今日内参",
      callback: async () => {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves[0]?.view?.bindTodayBriefing) await leaves[0].view.bindTodayBriefing();
      },
    });

    this.addSettingTab(new HorizonDiscussSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      new Notice(`Horizon Discuss：OpenCode Zen / ${this.settings.model}`, 5000);
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf("split");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadCredentials(opts = {}) {
    const needVision = !!opts.needVision;
    const preferredModel = needVision
      ? this.settings.visionModel || OPENCODE_VISION_MODEL
      : this.settings.model || OPENCODE_DEFAULT_MODEL;

    // 1) 默认：OpenCode Zen
    const zen = readOpenCodeZenKey();
    if (zen) {
      return {
        apiKey: zen.key,
        baseUrl: OPENCODE_ZEN_BASE,
        model: preferredModel,
        provider: "opencode-zen",
        providerLabel: "OpenCode Zen",
        switchedVision: needVision,
      };
    }

    // 2) 回退：Copilot / SiliconFlow（尤其识图）
    const sf = await this.loadSiliconflowFallback(needVision);
    if (sf) return sf;

    throw new Error(
      "未找到 OpenCode Zen Key（~/.local/share/opencode/auth.json），且 Copilot 也无可用 API Key"
    );
  }

  async loadSiliconflowFallback(needVision) {
    if (!(await this.app.vault.adapter.exists(COPILOT_DATA))) return null;
    const raw = await this.app.vault.adapter.read(COPILOT_DATA);
    const data = JSON.parse(raw);
    let apiKey = data.siliconflowApiKey || data.deepseekApiKey || data.openAIApiKey || "";
    if (!apiKey) return null;

    let baseUrl = "https://api.siliconflow.com/v1";
    let model = data.defaultModelKey?.split("|")[0] || "deepseek-ai/DeepSeek-V3";
    if (data.siliconflowApiKey) {
      apiKey = data.siliconflowApiKey;
      baseUrl = "https://api.siliconflow.com/v1";
    } else if (data.deepseekApiKey) {
      apiKey = data.deepseekApiKey;
      baseUrl = "https://api.deepseek.com/v1";
      model = "deepseek-chat";
    }

    if (needVision && !looksLikeVisionModel(model)) {
      const actives = data.activeModels || [];
      const pick =
        actives.find((m) => m.provider === "siliconflow" && looksLikeVisionModel(m.name))?.name ||
        SILICONFLOW_VISION_FALLBACK.find((name) =>
          actives.some((m) => m.name === name && m.provider === "siliconflow")
        ) ||
        SILICONFLOW_VISION_FALLBACK[0];
      model = pick;
    }

    return {
      apiKey,
      baseUrl,
      model,
      provider: "siliconflow-fallback",
      providerLabel: "SiliconFlow(回退)",
      switchedVision: needVision,
    };
  }

  async ensureFolder(pathStr) {
    const parts = pathStr.split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await this.app.vault.adapter.exists(cur))) {
        await this.app.vault.createFolder(cur);
      }
    }
  }

  extractTitle(md) {
    const m = md.match(/^#\s+(.+)$/m);
    return (m ? m[1] : "Briefing discussion").trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 40);
  }

  async writeIngestResults({ organized, type, typeLabel, briefingPath, discussText }) {
    const s = resolveSettings(this.settings);
    const day = todayStr();
    const title = this.extractTitle(organized);
    const briefingBase = briefingPath.split("/").pop().replace(/\.md$/, "");
    const extraLinks = reviewLinkLines(s);
    const relatedYaml = extraLinks
      ? extraLinks
          .replace(/^- \[\[/g, "")
          .replace(/\]\]$/gm, "")
          .split("\n")
          .map((l) => `  - "[[${l.trim()}]]"`)
          .join("\n")
      : "";

    await this.ensureFolder(s.briefingDir);
    await this.ensureFolder(s.wikiSessionsDir);
    await this.ensureFolder(s.dailyLogDir);

    const wikiName = `${s.sessionNamePrefix}-${title}-${day}`;
    const wikiPath = `${s.wikiSessionsDir}/${wikiName}.md`;
    const wikiBody = `---
type: session
title: "${title}"
source: "[[${briefingBase}]]"
note_type: ${type}
created: ${day}
updated: ${day}
tags:
  - horizon-discuss
  - briefing
  - ${type}
related:
  - "[[${briefingBase}]]"
${relatedYaml}
---

${organized}

## Discussion appendix

<details>
<summary>Expand</summary>

${truncate(discussText, 8000)}

</details>
`;
    if (await this.app.vault.adapter.exists(wikiPath)) {
      await this.app.vault.adapter.write(wikiPath, wikiBody);
    } else {
      await this.app.vault.create(wikiPath, wikiBody);
    }

    const morningPath = `${s.briefingDir}/${s.morningNotePrefix}${day}.md`;
    const morningLink = `${s.morningNotePrefix}${day}`;
    const section = `

---

## Discussion · ${title}

**Type**: ${typeLabel}  
**Briefing**: [[${briefingBase}]]  
**Wiki**: [[${wikiName}]]

${organized}

`;
    if (await this.app.vault.adapter.exists(morningPath)) {
      const prev = await this.app.vault.adapter.read(morningPath);
      await this.app.vault.adapter.write(morningPath, prev.trimEnd() + "\n" + section);
    } else {
      const templateHint = extraLinks ? `\n> Template links: ${extraLinks.replace(/\n/g, " ")}` : "";
      const header = `---
type: daily-briefing-review
date: ${day}
briefing: "[[${briefingBase}]]"
tags:
  - horizon-discuss
  - morning-review
---

# Morning review ${day}

**Briefing**: [[${briefingBase}]]${templateHint}
`;
      await this.app.vault.create(morningPath, header + section);
    }

    if (await this.app.vault.adapter.exists(briefingPath)) {
      const brief = await this.app.vault.adapter.read(briefingPath);
      const stamp = `\n\n---\n\nDiscussed → [[${wikiName}]] · [[${morningLink}]]\n`;
      if (!brief.includes(`[[${wikiName}]]`)) {
        await this.app.vault.adapter.write(briefingPath, brief.trimEnd() + stamp);
      }
    }

    const logPath = `${s.dailyLogDir}/${day}.md`;
    const points = extractKeyPointsTable(organized);
    let prev = "";
    if (await this.app.vault.adapter.exists(logPath)) {
      prev = await this.app.vault.adapter.read(logPath);
    }
    if (prev.includes(`[[${wikiName}]]`)) {
      return { wiki: wikiPath, morning: morningPath, log: logPath };
    }

    const n = nextDailyEntryNumber(prev);
    const logEntry = `

---

# ${n}. Briefing discussion · ${title}

**Type**: ${typeLabel}

## Source

| File | Note |
|------|------|
| \`${briefingPath}\` | Briefing |
| \`${s.briefingDir}/${morningLink}.md\` | Morning note |

## Wiki

| Type | Link |
|------|------|
| session | [[${wikiName}]] |
| briefing | [[${briefingBase}]] |
| morning | [[${morningLink}]] |

## Key points

| Point | Summary |
|-------|---------|
${points}

### Review path

- [[${wikiName}]]
- [[${briefingBase}]]
${extraLinks}
`;

    if (prev) {
      await this.app.vault.adapter.write(logPath, prev.trimEnd() + "\n" + logEntry);
    } else {
      const header = `# ${day} study log

${s.dailyLogIntro}`;
      await this.app.vault.create(logPath, header + logEntry);
    }

    return { wiki: wikiPath, morning: morningPath, log: logPath };
  }
}

class HorizonDiscussSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Horizon Discuss" });
    containerEl.createEl("p", {
      text: "Uses OpenCode Zen API key from your local OpenCode install. Fallback: Copilot plugin keys.",
    });

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("OpenCode Zen model id, e.g. claude-haiku-4-5")
      .addText((t) =>
        t.setValue(s.model).onChange(async (v) => {
          this.plugin.settings.model = (v || OPENCODE_DEFAULT_MODEL).trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Vision model")
      .setDesc("Model used when images are attached")
      .addText((t) =>
        t.setValue(s.visionModel).onChange(async (v) => {
          this.plugin.settings.visionModel = (v || OPENCODE_VISION_MODEL).trim();
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Vault paths" });

    const pathFields = [
      ["briefingDir", "Briefing folder", "Folder containing daily briefing notes"],
      ["dailyLogDir", "Daily log folder", "Folder for numbered study log entries"],
      ["wikiSessionsDir", "Wiki sessions folder", "Where session notes are saved"],
      ["copilotConvDir", "Copilot conversations folder", "For importing Copilot chats"],
      ["briefingFilePrefix", "Briefing filename prefix", "e.g. horizon-"],
      ["briefingFileSuffix", "Briefing filename suffix", "e.g. -zh"],
      ["morningNotePrefix", "Morning note prefix", "e.g. morning- or 晨读-"],
      ["sessionNamePrefix", "Session note prefix", "Wiki session filename prefix"],
      ["reviewLinks", "Extra review wikilinks", "Comma-separated note names"],
      ["dailyLogIntro", "Daily log header", "Markdown shown when creating a new log file"],
      ["focusTopics", "Focus topics", "Used in AI prompts for relevance (comma-separated OK)"],
    ];
    for (const [key, name, desc] of pathFields) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(s[key] || "").onChange(async (v) => {
            this.plugin.settings[key] = v.trim();
            await this.plugin.saveSettings();
          })
        );
    }
  }
}

module.exports = HorizonDiscussPlugin;


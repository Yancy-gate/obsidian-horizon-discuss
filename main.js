const { Plugin, ItemView, WorkspaceLeaf, Notice, Modal, Setting, MarkdownRenderer, PluginSettingTab, requestUrl } = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

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
const MAX_WEB_CHARS = 15000;
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
const MAX_IMAGE_SIDE = 1280;
const IMAGE_JPEG_QUALITY = 0.85;
const CHAT_SESSION_REL = ".obsidian/plugins/horizon-discuss/chat-session.json";
const CHAT_ASSETS_REL = ".obsidian/plugins/horizon-discuss/chat-assets";
const CHAT_PERSIST_DEBOUNCE_MS = 500;

// OpenCode Zen API（模型由用户在设置中自行填写，插件不设默认）
const OPENCODE_ZEN_BASE = "https://opencode.ai/zen/v1";
const SILICONFLOW_VISION_FALLBACK = [
  "zai-org/GLM-5V-Turbo",
  "Qwen/Qwen3-VL-32B-Instruct",
];

function dataUrlToBytes(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1];
  const binary = atob(m[2]);
  const bin = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bin[i] = binary.charCodeAt(i);
  const ext =
    /png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : /gif/i.test(mime) ? "gif" : "jpg";
  return { mime, bin, ext };
}

function bytesToDataUrl(mime, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return `data:${mime || "image/jpeg"};base64,${btoa(binary)}`;
}

const DEFAULT_SETTINGS = {
  provider: "opencode-zen",
  model: "",
  visionModel: "",
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
  agentReachPython: "",
  autoFetchUrls: true,
  maxWebChars: MAX_WEB_CHARS,
};

function extractUrls(text) {
  const found = String(text || "").match(URL_REGEX) || [];
  const seen = new Set();
  const out = [];
  for (let u of found) {
    u = u.replace(/[.,;:!?)]+$/, "");
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function defaultAgentReachPython() {
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".agent-reach-venv", "Scripts", "python.exe"),
          path.join(home, "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
        ]
      : [
          path.join(home, ".agent-reach-venv", "bin", "python3"),
          path.join(home, ".agent-reach-venv", "bin", "python"),
          "/usr/bin/python3",
        ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return process.platform === "win32" ? "python" : "python3";
}

async function readWebViaJina(url) {
  const target = url.startsWith("http") ? url : `https://${url}`;
  const jinaUrl = `https://r.jina.ai/${target}`;
  const res = await nodeGetText(jinaUrl, {
    "User-Agent": "Horizon-Discuss/1.0 (Agent Reach Jina Reader)",
    Accept: "text/plain",
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Jina Reader ${res.status}: ${String(res.text || "").slice(0, 200)}`);
  }
  return res.text;
}

function nodeGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error(`无效 URL：${url}`));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, text }));
      }
    );
    req.on("error", (e) => reject(new Error(`网络请求失败：${e.message}`)));
    req.end();
  });
}

function resolveChatModel(settings, needVision) {
  const s = resolveSettings(settings);
  if (needVision) {
    const model = (s.visionModel || s.model || "").trim();
    if (!model) {
      throw new Error("请先在 设置 → Horizon Discuss 填写 Vision model（或 Default model）");
    }
    return model;
  }
  const model = (s.model || "").trim();
  if (!model) {
    throw new Error("请先在 设置 → Horizon Discuss 填写 Default model（OpenCode Zen model id）");
  }
  return model;
}

function resolveSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  if (!s.agentReachPython) s.agentReachPython = defaultAgentReachPython();
  return s;
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
    const understand = organized.match(/#{2,3}\s*我的理解\s*\n([\s\S]*?)(?=\n#{2,3}\s|$)/);
    if (understand) {
      const t = understand[1].replace(/\s+/g, " ").trim().slice(0, 120);
      if (t) bullets.push(t);
    }
  }
  if (!bullets.length) bullets.push("See session body");
  return bullets.map((b, i) => `| ${i === 0 ? "Point" : "Extra"}${i + 1} | ${b.slice(0, 80)} |`).join("\n");
}

function escapeHdKey(title) {
  return String(title || "")
    .replace(/-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** 用 HTML 注释包裹章节，避免正文里的 ## 把 upsert 截断 */
function wrapHdSection(key, inner) {
  const k = escapeHdKey(key);
  return `\n\n<!--hd:${k}-->\n${String(inner || "").trim()}\n<!--/hd:${k}-->\n`;
}

function upsertHdSection(text, key, inner) {
  const body = text || "";
  const k = escapeHdKey(key);
  const start = `<!--hd:${k}-->`;
  const end = `<!--/hd:${k}-->`;
  const block = wrapHdSection(k, inner);
  const startIdx = body.indexOf(start);
  if (startIdx === -1) return body.trimEnd() + block;
  const endIdx = body.indexOf(end, startIdx);
  if (endIdx === -1) {
    // 旧格式无结束标记：从 start 起替换到下一个同级 hd 标记或文末
    const rest = body.slice(startIdx + start.length);
    const next = rest.search(/\n<!--hd:/);
    const before = body.slice(0, startIdx);
    const after = next === -1 ? "" : rest.slice(next);
    return before.trimEnd() + block + after;
  }
  return body.slice(0, startIdx).trimEnd() + block + body.slice(endIdx + end.length);
}

/**
 * 把 Markdown 标题降成普通行，避免附录/正文里的 # ## 污染 Obsidian 大纲与折叠，
 * 导致「过一会儿只剩第一条」的错觉或错误折叠。
 */
function flattenMdHeadings(md) {
  return String(md || "").replace(/^#{1,6}\s+(.+)$/gm, (_, title) => `【${String(title).trim()}】`);
}

/** 卡片正文：去掉重复一级标题，结构小节用 ###，其余标题全部压平 */
function normalizeCardMarkdown(md, title) {
  let text = String(md || "").trim();
  if (!text) return "";
  // 去掉与章节同名的开头 # 标题
  if (title) {
    const re = new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n+`, "i");
    text = text.replace(re, "");
  }
  text = text.replace(/^#\s+(.+)$/m, "【$1】");
  // ## 结构节 → ###
  text = text.replace(/^##\s+(来源|发生了什么|我的理解|未决问题|下一步)\s*$/gm, "### $1");
  // 其余 ## / #### 等压平，避免再冒出大纲项
  text = text.replace(/^##(?!#)\s+(.+)$/gm, "【$1】");
  text = text.replace(/^####+\s+(.+)$/gm, "【$1】");
  // 去掉与章节同名的【标题】占位行
  if (title) {
    const re2 = new RegExp(`^【${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}】\\s*\\n+`, "i");
    text = text.replace(re2, "");
  }
  return text.trim();
}

function buildAppendixBlock(discussText) {
  const body = flattenMdHeadings(truncate(discussText || "", 50000));
  return `<details>
<summary>完整讨论附录（标题已降级，不影响大纲）</summary>

${body}

</details>`;
}

function replaceMarkdownSection(text, heading, newBlock) {
  const body = text || "";
  const idx = body.indexOf(heading);
  if (idx === -1) return body.trimEnd() + newBlock;
  const levelMatch = heading.match(/^(#+)\s/);
  const level = levelMatch ? levelMatch[1].length : 2;
  const after = body.slice(idx + heading.length);
  // 只在同级或更高级标题处结束，避免被正文 ### / 更深标题误切；仍可能被同级 ## 误切，优先用 upsertHdSection
  const nextIdx = after.search(new RegExp(`\\n#{1,${level}}\\s`));
  const tail = nextIdx === -1 ? "" : after.slice(nextIdx);
  return body.slice(0, idx) + newBlock.trimEnd() + tail;
}

function upsertMarkdownSection(text, heading, newBlock) {
  const body = text || "";
  if (body.includes(heading)) return replaceMarkdownSection(body, heading, newBlock);
  return body.trimEnd() + newBlock;
}

/** 把模型输出拆成多张入库卡（多话题） */
function parseIngestCards(organized) {
  const raw = String(organized || "").trim();
  if (!raw) return [];

  const bySep = raw
    .split(/\n\s*---CARD---\s*\n/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (bySep.length > 1) {
    return bySep.map((md) => ({
      title: (md.match(/^#\s+(.+)$/m) || [, "讨论沉淀"])[1].trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 40),
      markdown: md,
    }));
  }

  // 多个顶级 # 标题 → 多卡
  const lines = raw.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+\S/.test(lines[i]) && !/^##/.test(lines[i])) starts.push(i);
  }
  if (starts.length > 1) {
    const cards = [];
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i];
      const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
      const md = lines.slice(from, to).join("\n").trim();
      if (!md) continue;
      cards.push({
        title: (md.match(/^#\s+(.+)$/m) || [, "讨论沉淀"])[1].trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 40),
        markdown: md,
      });
    }
    if (cards.length) return cards;
  }

  return [
    {
      title: (raw.match(/^#\s+(.+)$/m) || [, "讨论沉淀"])[1].trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 40),
      markdown: raw,
    },
  ];
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
  if (m.webPages?.length) {
    const blocks = m.webPages
      .map(
        (w) =>
          `\n\n---\n网页：${w.url}\n来源：${w.backend || "Agent Reach"}\n\`\`\`\n${truncate(w.text || "", MAX_WEB_CHARS)}\n\`\`\``
      )
      .join("");
    text = (text || "请结合下列网页内容回答") + blocks;
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
    this.pendingWebPages = [];
    this.briefingPath = null;
    this.briefingExcerpt = "";
    this.statusEl = null;
    this.listEl = null;
    this.inputEl = null;
    this.typeEl = null;
    this.pendingEl = null;
    this.composerEl = null;
    this._persistTimer = null;
    this._persistBusy = false;
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
    const fetchWebBtn = row1.createEl("button", { text: "抓取网页" });
    fetchWebBtn.onclick = () => this.promptFetchWebPage();

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
    this.typeEl.addEventListener("change", () => this.schedulePersist());

    this.listEl = root.createDiv({ cls: "hd-messages" });

    const composer = root.createDiv({ cls: "hd-composer" });
    this.composerEl = composer;
    this.pendingEl = composer.createDiv({ cls: "hd-pending" });

    this.inputEl = composer.createEl("textarea", {
      cls: "hd-input",
      attr: {
        placeholder:
          "围绕今日内参提问…（可粘贴链接自动抓取；Ctrl+V 截图；拖入文件；Enter 发送）",
      },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.inputEl.addEventListener("paste", (e) => this.handlePaste(e));
    this.inputEl.addEventListener("input", () => this.schedulePersist());

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
    clearChat.onclick = async () => {
      this.messages = [];
      this.pendingImages = [];
      this.pendingFiles = [];
      this.pendingWebPages = [];
      if (this.inputEl) this.inputEl.value = "";
      this.renderPending();
      await this.renderMessages();
      await this.plugin.clearChatSession();
      this.setStatus("已清空对话（本地缓存已删除）");
      new Notice("对话已清空");
    };

    this.statusEl = root.createDiv({ cls: "hd-status" });
    await this.restoreChatSession();
    this.renderPending();
    await this.renderMessages();
    if (this.messages.length) {
      this.setStatus(`已恢复 ${this.messages.length} 条对话`);
    }
  }

  async onClose() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    try {
      await this.persistChatSession(true);
    } catch (e) {
      console.error("persist chat on close failed", e);
    }
  }

  schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.persistChatSession(false).catch((e) => console.error("persist chat failed", e));
    }, CHAT_PERSIST_DEBOUNCE_MS);
  }

  async persistChatSession(immediate = false) {
    if (this._persistBusy) return;
    this._persistBusy = true;
    try {
      await this.plugin.saveChatSession({
        version: 1,
        updatedAt: Date.now(),
        briefingPath: this.briefingPath || null,
        ingestType: this.typeEl?.value || "understand",
        inputDraft: this.inputEl?.value || "",
        messages: this.messages || [],
        pendingImages: this.pendingImages || [],
        pendingFiles: this.pendingFiles || [],
        pendingWebPages: this.pendingWebPages || [],
      });
    } finally {
      this._persistBusy = false;
    }
  }

  async restoreChatSession() {
    let session = null;
    try {
      session = await this.plugin.loadChatSession();
    } catch (e) {
      console.error("load chat session failed", e);
    }

    if (session?.briefingPath) {
      try {
        if (await this.app.vault.adapter.exists(session.briefingPath)) {
          await this.loadBriefing(session.briefingPath);
        } else {
          await this.bindTodayBriefing(true);
        }
      } catch (e) {
        await this.bindTodayBriefing(true);
      }
    } else {
      await this.bindTodayBriefing(true);
    }

    if (!session) return;

    if (session.ingestType && this.typeEl) {
      this.typeEl.value = session.ingestType;
    }
    if (typeof session.inputDraft === "string" && this.inputEl) {
      this.inputEl.value = session.inputDraft;
    }
    this.messages = Array.isArray(session.messages) ? session.messages : [];
    this.pendingImages = Array.isArray(session.pendingImages) ? session.pendingImages : [];
    this.pendingFiles = Array.isArray(session.pendingFiles) ? session.pendingFiles : [];
    this.pendingWebPages = Array.isArray(session.pendingWebPages) ? session.pendingWebPages : [];
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text || "");
  }

  renderPending() {
    if (!this.pendingEl) return;
    this.pendingEl.empty();
    if (!this.pendingImages.length && !this.pendingFiles.length && !this.pendingWebPages.length) {
      this.schedulePersist();
      return;
    }

    const parts = [];
    if (this.pendingImages.length) parts.push(`${this.pendingImages.length} 图`);
    if (this.pendingFiles.length) parts.push(`${this.pendingFiles.length} 文件`);
    if (this.pendingWebPages.length) parts.push(`${this.pendingWebPages.length} 网页`);
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

    if (this.pendingWebPages.length) {
      const row = this.pendingEl.createDiv({ cls: "hd-pending-web" });
      for (const w of this.pendingWebPages) {
        const chip = row.createDiv({ cls: "hd-web-chip" });
        const label = w.backend ? `${w.url} · ${w.backend}` : w.url;
        chip.createSpan({ cls: "hd-web-name", text: label, attr: { title: label } });
        const rm = chip.createEl("button", { text: "×", cls: "hd-web-remove" });
        rm.onclick = () => {
          this.pendingWebPages = this.pendingWebPages.filter((x) => x.id !== w.id);
          this.renderPending();
        };
      }
    }

    this.schedulePersist();
  }

  async promptFetchWebPage() {
    const url = window.prompt("输入要抓取的网页 URL（使用 Agent Reach 路由）", "https://");
    if (!url || !url.trim()) return;
    await this.fetchAndAddWebPage(url.trim());
  }

  async fetchAndAddWebPage(url) {
    if (this.pendingWebPages.some((w) => w.url === url)) {
      new Notice("该链接已在待发送列表");
      return;
    }
    this.setStatus(`抓取网页中… ${url}`);
    try {
      const page = await this.plugin.fetchUrlWithAgentReach(url);
      this.pendingWebPages.push({
        id: uid(),
        url: page.url,
        backend: page.backend,
        text: page.text,
      });
      this.renderPending();
      this.setStatus(`已抓取 · ${page.backend}`);
      new Notice(`网页已抓取：${page.backend}`);
    } catch (e) {
      console.error(e);
      this.setStatus("网页抓取失败");
      new Notice(`抓取失败：${e.message || e}`);
    }
  }

  async autoFetchUrlsFromText(text) {
    if (!this.plugin.settings.autoFetchUrls) return;
    const urls = extractUrls(text).filter((u) => !this.pendingWebPages.some((w) => w.url === u));
    for (const url of urls.slice(0, 3)) {
      await this.fetchAndAddWebPage(url);
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
    this.schedulePersist();
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
      await this.renderMessages();
      this.schedulePersist();
      new Notice(`已导入 ${parsed.length} 条消息（可勾选后入库）`);
    });
    modal.open();
  }

  setAllSelected(v) {
    for (const m of this.messages) m.selected = v;
    this.renderMessages();
    this.schedulePersist();
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
        this.schedulePersist();
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
      if (m.webPages?.length) {
        top.createSpan({ cls: "hd-msg-badge", text: `${m.webPages.length} 网页` });
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
    let text = (this.inputEl.value || "").trim();
    const images = this.pendingImages.slice();
    const files = this.pendingFiles.slice();
    if (!text && !images.length && !files.length && !this.pendingWebPages.length) return;
    if (!this.briefingPath) {
      new Notice("请先绑定今日内参");
      return;
    }

    if (text) await this.autoFetchUrlsFromText(text);

    const webPages = this.pendingWebPages.slice();
    const parts = [];
    if (images.length) parts.push(`${images.length} 张图`);
    if (files.length) parts.push(`${files.length} 个附件`);
    if (webPages.length) parts.push(`${webPages.length} 个网页`);
    const focus = this.plugin.settings.focusTopics || DEFAULT_SETTINGS.focusTopics;
    const userText =
      text ||
      (parts.length
        ? `请结合今日内参与${parts.join("、")}回答：说明关键信息、与主线（${focus}）的关联、可行动下一步。`
        : "");

    this.inputEl.value = "";
    this.pendingImages = [];
    this.pendingFiles = [];
    this.pendingWebPages = [];
    this.renderPending();

    this.messages.push({
      id: uid(),
      role: "user",
      content: userText,
      images,
      files,
      webPages,
      selected: true,
    });
    await this.renderMessages();
    this.schedulePersist();
    this.setStatus(images.length ? "识图思考中…" : webPages.length ? "结合网页思考中…" : "思考中…");

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
      this.schedulePersist();
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
          const webNote = m.webPages?.length
            ? `\n（网页：${m.webPages.map((w) => w.url).join("、")}）`
            : "";
          return `【${m.role === "user" ? "用户" : "AI"}】\n${m.content || ""}${imgNote}${fileNote}${webNote}`;
        })
        .join("\n\n---\n\n");

      const focus = this.plugin.settings.focusTopics || DEFAULT_SETTINGS.focusTopics;
      const turnCount = selected.length;
      const prompt = `你是 Obsidian 知识库整理助手。根据「今日内参摘录」和「用户勾选的全部讨论」，整理成可入库的中文笔记。

硬性要求：
1. 只输出 Markdown，不要用代码围栏包裹全文
2. **必须覆盖勾选讨论里的每一个用户问题/主题**，不得只留一条、不得把后半段丢掉
3. 若讨论有多个不同主题（例如：概念解释、机制拆解、横向对比、行业信号、行动项），输出**多张卡片**
4. 多张卡片之间用单独一行分隔符：
---CARD---
5. 每张卡片结构固定为：
# （该话题简洁标题，≤20字）
### 来源
### 发生了什么
### 我的理解
### 未决问题
### 下一步
6. 「我的理解」优先保留用户原话与判断；要点要全，但避免空话套话
7. 「下一步」用 - [ ] 清单，每卡最多 5 条
8. 类型提示：这是「${typeLabel}」；关注领域：${focus}
9. 涉及图片时概括可见信息，不臆造
10. 当前勾选共 ${turnCount} 条消息；若主题≥2，必须输出≥2 张卡片

今日内参路径：${this.briefingPath}

内参摘录：
${this.briefingExcerpt.slice(0, 12000)}

勾选的讨论（全文，请全部纳入整理）：
${discussText}
`;

      const ingestMessages = [
        {
          role: "system",
          content:
            "你输出干净的 Markdown 笔记。多主题时必须输出多张卡片，用 ---CARD--- 分隔。禁止只总结成一张而丢掉后半讨论。",
        },
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

      const organized = await chatCompletion(creds, ingestMessages, { maxTokens: 8000 });
      const cards = parseIngestCards(organized);
      if (!cards.length) throw new Error("整理结果为空");

      const paths = await this.plugin.writeIngestResults({
        cards,
        type,
        typeLabel,
        briefingPath: this.briefingPath,
        discussText,
      });

      this.setStatus(`已入库 ${cards.length} 个话题 → ${paths.wiki}`);
      new Notice(`已入库 ${cards.length} 个话题到今日 wiki / 晨读 / 学习日志`);
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

/**
 * OpenCode Zen 按模型走不同端点：
 * - gpt-* / *codex* → /v1/responses（OpenAI Responses）
 * - 其余兼容模型 → /v1/chat/completions
 * 之前对 gpt-5.4-mini 误打 chat/completions，会返回怪异的 400 + 空 assistant。
 */
function zenApiStyle(model, provider) {
  if (provider && provider !== "opencode-zen") return "chat";
  const m = String(model || "").toLowerCase();
  if (m.startsWith("gpt-") || m.includes("codex")) return "responses";
  return "chat";
}

function chatContentToResponsesParts(content, role) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");

  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && p.text != null) {
      parts.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: String(p.text),
      });
    } else if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (url) parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts.length ? parts : "";
}

function buildResponsesBody(model, messages, maxTokens) {
  let instructions = "";
  const input = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "system") {
      const c = m.content;
      instructions += (instructions ? "\n\n" : "") + (typeof c === "string" ? c : JSON.stringify(c));
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    input.push({
      role,
      content: chatContentToResponsesParts(m.content, role),
    });
  }
  const body = {
    model,
    input,
    max_output_tokens: maxTokens || 2048,
  };
  if (instructions) body.instructions = instructions;
  return body;
}

function extractResponsesText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const parts = [];
  for (const item of data.output || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const c of item.content || []) {
        if (c?.type === "output_text" && c.text) parts.push(c.text);
      }
    } else if (item.type === "output_text" && item.text) {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return "";
  return typeof content === "string" ? content.trim() : JSON.stringify(content);
}

async function chatCompletion(creds, messages, opts = {}) {
  const style = zenApiStyle(creds.model, creds.provider);
  const base = creds.baseUrl.replace(/\/$/, "");
  const maxTokens = opts.maxTokens || 2048;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${creds.apiKey}`,
  };

  let url;
  let bodyObj;
  if (style === "responses") {
    url = `${base}/responses`;
    bodyObj = buildResponsesBody(creds.model, messages, maxTokens);
  } else {
    url = `${base}/chat/completions`;
    bodyObj = {
      model: creds.model,
      messages,
      temperature: 0.25,
      max_tokens: maxTokens,
    };
  }

  const body = JSON.stringify(bodyObj);
  const res = await postJson(url, headers, body);
  if (res.status < 200 || res.status >= 300) {
    const errText = String(res.text || JSON.stringify(res.json) || "").slice(0, 400);
    const hint =
      style === "responses"
        ? ""
        : /gpt-|codex/i.test(creds.model || "")
          ? "（提示：该 GPT 模型应走 /v1/responses，请升级插件或换 deepseek-v4-flash）"
          : "";
    throw new Error(`${res.status} ${errText}${hint}`);
  }

  const data = res.json || (() => {
    try {
      return JSON.parse(res.text || "{}");
    } catch (e) {
      return null;
    }
  })();

  const content = style === "responses" ? extractResponsesText(data) : extractChatText(data);
  if (!content) {
    const status = data?.status || data?.choices?.[0]?.finish_reason || "";
    throw new Error(
      `模型返回为空${status ? `（${status}）` : ""}。可尝试换模型，或增大生成长度。`
    );
  }
  return content;
}

async function postJson(url, headers, body) {
  try {
    const res = await requestUrl({
      url,
      method: "POST",
      headers,
      body,
      throw: false,
    });
    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, text: res.text, json: res.json };
    }
    if (res.status > 0) {
      return { status: res.status, text: res.text, json: res.json };
    }
  } catch (e) {
    console.warn("requestUrl failed, falling back to Node https", e);
  }
  return nodePostJson(url, headers, body);
}

function nodePostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error(`无效 URL：${url}`));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            /* ignore */
          }
          resolve({ status: res.statusCode || 0, text, json });
        });
      }
    );
    req.on("error", (e) => reject(new Error(`网络请求失败：${e.message}`)));
    req.write(body);
    req.end();
  });
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
      const label = (this.settings.model || "").trim() || "未配置模型";
      new Notice(`Horizon Discuss · ${label}`, 5000);
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  chatSessionPath() {
    return CHAT_SESSION_REL;
  }

  chatAssetsDir() {
    return CHAT_ASSETS_REL;
  }

  async ensureChatAssetsDir() {
    const dir = this.chatAssetsDir();
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  async writeChatImageAsset(dataUrl, preferredName) {
    const parsed = dataUrlToBytes(dataUrl);
    if (!parsed) return null;
    await this.ensureChatAssetsDir();
    const base = String(preferredName || "img")
      .replace(/[^\w.\-()+一-龥]/g, "_")
      .slice(0, 40);
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${base}.${parsed.ext}`;
    const rel = `${this.chatAssetsDir()}/${fileName}`;
    await this.app.vault.adapter.writeBinary(rel, parsed.bin);
    return { asset: fileName, mime: parsed.mime, name: preferredName || fileName };
  }

  async readChatImageAsset(asset, mime) {
    const rel = `${this.chatAssetsDir()}/${asset}`;
    if (!(await this.app.vault.adapter.exists(rel))) return null;
    const bytes = await this.app.vault.adapter.readBinary(rel);
    return bytesToDataUrl(mime || "image/jpeg", bytes);
  }

  async serializeImagesForPersist(images) {
    const out = [];
    for (const img of images || []) {
      if (!img) continue;
      let asset = img.asset;
      let mime = img.mime || "image/jpeg";
      let name = img.name || img.path || "image";
      if (!asset && img.dataUrl) {
        const saved = await this.writeChatImageAsset(img.dataUrl, name);
        if (saved) {
          asset = saved.asset;
          mime = saved.mime;
          name = saved.name;
        }
      }
      const row = { id: img.id || uid(), name, mime, path: img.path || null };
      if (asset) row.asset = asset;
      // 不把巨大 dataUrl 写进 JSON；若无 asset 则放弃该图的持久化
      out.push(row);
    }
    return out;
  }

  async hydrateImages(images) {
    const out = [];
    for (const img of images || []) {
      if (!img) continue;
      const row = {
        id: img.id || uid(),
        name: img.name || "image",
        mime: img.mime || "image/jpeg",
        path: img.path || null,
        asset: img.asset || null,
        dataUrl: img.dataUrl || null,
      };
      if (!row.dataUrl && row.asset) {
        try {
          row.dataUrl = await this.readChatImageAsset(row.asset, row.mime);
        } catch (e) {
          console.error("hydrate image failed", row.asset, e);
        }
      }
      if (row.dataUrl || row.asset) out.push(row);
    }
    return out;
  }

  async serializeMessagesForPersist(messages) {
    const out = [];
    for (const m of messages || []) {
      out.push({
        id: m.id || uid(),
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content || "",
        selected: !!m.selected,
        images: await this.serializeImagesForPersist(m.images || []),
        files: (m.files || []).map((f) => ({
          id: f.id || uid(),
          name: f.name || f.path || "file",
          path: f.path || null,
          text: truncate(f.text || "", MAX_FILE_CHARS),
        })),
        webPages: (m.webPages || []).map((w) => ({
          url: w.url,
          backend: w.backend || "",
          text: truncate(w.text || "", MAX_WEB_CHARS),
        })),
      });
    }
    return out;
  }

  async hydrateMessages(messages) {
    const out = [];
    for (const m of messages || []) {
      out.push({
        id: m.id || uid(),
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content || "",
        selected: !!m.selected,
        images: await this.hydrateImages(m.images || []),
        files: Array.isArray(m.files) ? m.files : [],
        webPages: Array.isArray(m.webPages) ? m.webPages : [],
      });
    }
    return out;
  }

  async loadChatSession() {
    const p = this.chatSessionPath();
    if (!(await this.app.vault.adapter.exists(p))) return null;
    const raw = await this.app.vault.adapter.read(p);
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return {
      version: data.version || 1,
      updatedAt: data.updatedAt || 0,
      briefingPath: data.briefingPath || null,
      ingestType: data.ingestType || "understand",
      inputDraft: data.inputDraft || "",
      messages: await this.hydrateMessages(data.messages || []),
      pendingImages: await this.hydrateImages(data.pendingImages || []),
      pendingFiles: Array.isArray(data.pendingFiles) ? data.pendingFiles : [],
      pendingWebPages: Array.isArray(data.pendingWebPages) ? data.pendingWebPages : [],
    };
  }

  async saveChatSession(state) {
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      briefingPath: state.briefingPath || null,
      ingestType: state.ingestType || "understand",
      inputDraft: state.inputDraft || "",
      messages: await this.serializeMessagesForPersist(state.messages || []),
      pendingImages: await this.serializeImagesForPersist(state.pendingImages || []),
      pendingFiles: (state.pendingFiles || []).map((f) => ({
        id: f.id || uid(),
        name: f.name || f.path || "file",
        path: f.path || null,
        text: truncate(f.text || "", MAX_FILE_CHARS),
      })),
      pendingWebPages: (state.pendingWebPages || []).map((w) => ({
        url: w.url,
        backend: w.backend || "",
        text: truncate(w.text || "", MAX_WEB_CHARS),
      })),
    };
    await this.app.vault.adapter.write(this.chatSessionPath(), JSON.stringify(payload, null, 2));
  }

  async clearChatSession() {
    const p = this.chatSessionPath();
    if (await this.app.vault.adapter.exists(p)) {
      await this.app.vault.adapter.remove(p);
    }
    const dir = this.chatAssetsDir();
    if (await this.app.vault.adapter.exists(dir)) {
      try {
        const listing = await this.app.vault.adapter.list(dir);
        for (const f of listing?.files || []) {
          try {
            await this.app.vault.adapter.remove(f);
          } catch (e) {
            /* ignore */
          }
        }
      } catch (e) {
        console.error("clear chat assets failed", e);
      }
    }
  }

  getAgentReachScriptPath() {
    return path.join(this.app.vault.configDir, "plugins", "horizon-discuss", "agent-reach-fetch.py");
  }

  async fetchUrlWithAgentReach(url) {
    const s = resolveSettings(this.settings);
    const maxChars = s.maxWebChars || MAX_WEB_CHARS;
    const scriptPath = this.getAgentReachScriptPath();
    const python = s.agentReachPython || defaultAgentReachPython();

    if (fs.existsSync(scriptPath)) {
      try {
        const { stdout } = await execFileAsync(python, [scriptPath, url], {
          maxBuffer: 12 * 1024 * 1024,
          timeout: 120000,
          windowsHide: true,
        });
        const data = JSON.parse(String(stdout || "").trim());
        if (data.ok && data.text) {
          return {
            url: data.url || url,
            backend: data.backend || "Agent Reach",
            text: String(data.text).slice(0, maxChars),
          };
        }
        throw new Error(data.error || "Agent Reach 返回空内容");
      } catch (e) {
        console.warn("agent-reach-fetch.py failed, fallback to Jina", e);
      }
    }

    const text = await readWebViaJina(url);
    return {
      url,
      backend: "Jina Reader (Agent Reach fallback)",
      text: String(text).slice(0, maxChars),
    };
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
    const preferredModel = resolveChatModel(this.settings, needVision);

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

  async writeIngestResults({ cards, organized, type, typeLabel, briefingPath, discussText }) {
    const s = resolveSettings(this.settings);
    const day = todayStr();
    const cardList =
      Array.isArray(cards) && cards.length
        ? cards
        : parseIngestCards(organized || "");
    if (!cardList.length) throw new Error("没有可写入的整理卡片");

    const briefingBase = briefingPath.split("/").pop().replace(/\.md$/, "");
    const extraLinks = reviewLinkLines(s);
    const relatedYaml = String(s.reviewLinks || "")
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((l) => `  - "[[${l}]]"`)
      .join("\n");

    await this.ensureFolder(s.briefingDir);
    await this.ensureFolder(s.wikiSessionsDir);
    await this.ensureFolder(s.dailyLogDir);

    const wikiName = `${s.sessionNamePrefix}-${day}`;
    const wikiPath = `${s.wikiSessionsDir}/${wikiName}.md`;
    const morningPath = `${s.briefingDir}/${s.morningNotePrefix}${day}.md`;
    const morningLink = `${s.morningNotePrefix}${day}`;
    const logPath = `${s.dailyLogDir}/${day}.md`;

    // —— Wiki：一天一页，多话题多章节 ——
    let wikiBody = "";
    if (await this.app.vault.adapter.exists(wikiPath)) {
      wikiBody = await this.app.vault.adapter.read(wikiPath);
      wikiBody = wikiBody.replace(/^updated: .+$/m, `updated: ${day}`);
    } else {
      wikiBody = `---
type: session
title: "${s.sessionNamePrefix} ${day}"
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

# ${s.sessionNamePrefix} · ${day}

**Briefing**: [[${briefingBase}]]
`;
    }

    for (const card of cardList) {
      const title = card.title || this.extractTitle(card.markdown);
      const bodyMd = normalizeCardMarkdown(card.markdown, title);
      const wikiInner = `## ${title}

**Type**: ${typeLabel} · **Briefing**: [[${briefingBase}]]

${bodyMd}`;
      wikiBody = upsertHdSection(wikiBody, `wiki:${title}`, wikiInner);
    }
    // 完整讨论只保留一份附录，避免每张卡重复粘贴 + 附录内 ## 污染大纲
    if (discussText && String(discussText).trim()) {
      wikiBody = upsertHdSection(wikiBody, "wiki:__appendix__", `## 完整讨论附录

${buildAppendixBlock(discussText)}`);
    }
    if (await this.app.vault.adapter.exists(wikiPath)) {
      await this.app.vault.adapter.write(wikiPath, wikiBody);
    } else {
      await this.app.vault.create(wikiPath, wikiBody);
    }

    // —— 晨读 ——
    let morningBody = "";
    if (await this.app.vault.adapter.exists(morningPath)) {
      morningBody = await this.app.vault.adapter.read(morningPath);
    } else {
      const templateHint = extraLinks ? `\n> Template links: ${extraLinks.replace(/\n/g, " ")}` : "";
      morningBody = `---
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
    }
    for (const card of cardList) {
      const title = card.title || this.extractTitle(card.markdown);
      const bodyMd = normalizeCardMarkdown(card.markdown, title);
      const morningInner = `---

## Discussion · ${title}

**Type**: ${typeLabel}  
**Briefing**: [[${briefingBase}]]  
**Wiki**: [[${wikiName}]]

${bodyMd}
`;
      morningBody = upsertHdSection(morningBody, `morning:${title}`, morningInner);
    }
    if (await this.app.vault.adapter.exists(morningPath)) {
      await this.app.vault.adapter.write(morningPath, morningBody);
    } else {
      await this.app.vault.create(morningPath, morningBody);
    }

    if (await this.app.vault.adapter.exists(briefingPath)) {
      const brief = await this.app.vault.adapter.read(briefingPath);
      const stamp = `\n\n---\n\nDiscussed → [[${wikiName}]] · [[${morningLink}]]\n`;
      if (!brief.includes(`[[${wikiName}]]`)) {
        await this.app.vault.adapter.write(briefingPath, brief.trimEnd() + stamp);
      }
    }

    // —— 每日学习日志：一天一条大条目，多话题用 ### ——
    let prev = "";
    if (await this.app.vault.adapter.exists(logPath)) {
      prev = await this.app.vault.adapter.read(logPath);
    }

    const logDayMarker = `Briefing discussion · ${day}`;
    let logBody = prev;
    if (!logBody.includes(logDayMarker)) {
      const n = nextDailyEntryNumber(logBody);
      const logEntry = `

---

# ${n}. ${logDayMarker}

**Briefing**: [[${briefingBase}]]

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

### Review path

- [[${wikiName}]]
- [[${briefingBase}]]
${extraLinks}
`;
      if (logBody) {
        logBody = logBody.trimEnd() + "\n" + logEntry;
      } else {
        logBody = `# ${day} study log

${s.dailyLogIntro}` + logEntry;
      }
    }

    for (const card of cardList) {
      const title = card.title || this.extractTitle(card.markdown);
      const points = extractKeyPointsTable(card.markdown);
      const logSubHeading = `### ${title}`;
      const logSubBlock = `

${logSubHeading}

**Type**: ${typeLabel}

| Point | Summary |
|-------|---------|
${points}

`;
      // 插到 Review path 之前；若已有同标题则用 hd 标记更新
      if (logBody.includes(`<!--hd:log:${escapeHdKey(title)}-->`)) {
        logBody = upsertHdSection(logBody, `log:${title}`, logSubBlock);
      } else if (logBody.includes(logSubHeading)) {
        logBody = upsertMarkdownSection(logBody, logSubHeading, logSubBlock);
      } else {
        const reviewIdx = logBody.indexOf("### Review path");
        if (reviewIdx !== -1 && logBody.includes(logDayMarker)) {
          // 插在当日条目的 Review path 前
          const dayIdx = logBody.indexOf(logDayMarker);
          const reviewInDay = logBody.indexOf("### Review path", dayIdx);
          if (reviewInDay !== -1) {
            logBody =
              logBody.slice(0, reviewInDay).trimEnd() +
              wrapHdSection(`log:${title}`, logSubBlock) +
              "\n" +
              logBody.slice(reviewInDay);
          } else {
            logBody = upsertHdSection(logBody, `log:${title}`, logSubBlock);
          }
        } else {
          logBody = upsertHdSection(logBody, `log:${title}`, logSubBlock);
        }
      }
    }

    if (await this.app.vault.adapter.exists(logPath)) {
      await this.app.vault.adapter.write(logPath, logBody);
    } else {
      await this.app.vault.create(logPath, logBody);
    }

    return { wiki: wikiPath, morning: morningPath, log: logPath, cardCount: cardList.length };
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
      .setDesc("Required. Zen model id，如 gpt-5.4-mini（自动走 /v1/responses）或 deepseek-v4-flash。")
      .addText((t) =>
        t.setValue(s.model || "").onChange(async (v) => {
          this.plugin.settings.model = (v || "").trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Vision model")
      .setDesc("Optional. 发图时使用；留空则用 Default。gpt-5.4-mini 支持识图。")
      .addText((t) =>
        t.setValue(s.visionModel || "").onChange(async (v) => {
          this.plugin.settings.visionModel = (v || "").trim();
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Agent Reach (web fetch)" });

    new Setting(containerEl)
      .setName("Agent Reach Python")
      .setDesc("Python from agent-reach venv, e.g. ~/.agent-reach-venv/Scripts/python.exe")
      .addText((t) =>
        t.setValue(s.agentReachPython || "").onChange(async (v) => {
          this.plugin.settings.agentReachPython = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-fetch URLs in message")
      .setDesc("When sending, auto-fetch links via Agent Reach (max 3 per message)")
      .addToggle((toggle) =>
        toggle.setValue(!!s.autoFetchUrls).onChange(async (v) => {
          this.plugin.settings.autoFetchUrls = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max web content chars")
      .setDesc("Truncate fetched page text before sending to the model")
      .addText((t) =>
        t.setValue(String(s.maxWebChars || MAX_WEB_CHARS)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxWebChars = Number.isNaN(n) ? MAX_WEB_CHARS : n;
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


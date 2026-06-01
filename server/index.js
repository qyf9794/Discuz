import "dotenv/config";
import cors from "cors";
import express from "express";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import multer from "multer";
import mammoth from "mammoth";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const dbPath = path.join(dataDir, "discuz.sqlite");
const port = Number(process.env.PORT || 8787);

fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,
    extracted_text TEXT NOT NULL DEFAULT '',
    rendered_html TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussion_records (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    note_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussion_inputs (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
`);

const fileColumns = db.prepare("PRAGMA table_info(files)").all().map((column) => column.name);
if (!fileColumns.includes("rendered_html")) {
  db.exec("ALTER TABLE files ADD COLUMN rendered_html TEXT NOT NULL DEFAULT ''");
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      file.originalname = normalizeUploadedFilename(file.originalname);
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 80 * 1024 * 1024 }
});

const app = express();
app.use(cors());
app.use("/api/realtime/session", express.text({ type: ["application/sdp", "text/plain"], limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use("/api/raw", express.static(uploadDir));

function now() {
  return new Date().toISOString();
}

function decodeMojibakeFilename(value) {
  const filename = String(value || "unknown");
  if (!/[\u0080-\u009f]/.test(filename)) return filename;
  try {
    const decoded = Buffer.from(filename, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? filename : decoded;
  } catch {
    return filename;
  }
}

function normalizeUploadedFilename(value) {
  const leaf = String(value || "unknown").split(/[\\/]/).filter(Boolean).pop() || "unknown";
  return decodeMojibakeFilename(leaf).normalize("NFC");
}

function rowToFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind,
    extractedText: row.extracted_text,
    renderedHtml: row.rendered_html,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    previewUrl: `/api/raw/${encodeURIComponent(row.stored_name)}`
  };
}

function detectKindFromMetadata(originalName, mimeType = "", storedName = "") {
  const ext = path.extname(originalName || storedName).toLowerCase() || path.extname(storedName).toLowerCase();
  const mime = mimeType || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime === "application/msword" || ext === ".doc") return "doc";
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".txt", ".csv", ".json", ".log", ".xml", ".html", ".css", ".js", ".ts", ".tsx", ".jsx"].includes(ext)) return "text";
  return "unknown";
}

function detectKind(file) {
  return detectKindFromMetadata(file.originalname, file.mimetype, file.filename);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanHtml(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim();
}

function summarizeText(text, fallbackName) {
  const cleaned = cleanText(text);
  if (!cleaned) return `${fallbackName} 已加入上下文。`;
  const sentences = cleaned
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
  const summary = sentences.join(" ");
  return summary.length > 260 ? `${summary.slice(0, 257)}...` : summary;
}

async function extractPdf(filePath) {
  const pdfParse = await import("pdf-parse");
  const dataBuffer = fs.readFileSync(filePath);
  const result = await pdfParse.default(dataBuffer);
  return { text: cleanText(result.text), html: "" };
}

async function extractDocx(filePath) {
  const [rawText, html] = await Promise.all([
    mammoth.extractRawText({ path: filePath }),
    mammoth.convertToHtml({ path: filePath })
  ]);
  return { text: cleanText(rawText.value), html: cleanHtml(html.value) };
}

async function extractDoc(filePath) {
  const [text, html] = await Promise.all([
    execFileAsync("textutil", ["-convert", "txt", "-stdout", filePath], { maxBuffer: 20 * 1024 * 1024 }),
    execFileAsync("textutil", ["-convert", "html", "-stdout", filePath], { maxBuffer: 50 * 1024 * 1024 })
  ]);
  return { text: cleanText(text.stdout), html: cleanHtml(html.stdout) };
}

function collectText(value, output = []) {
  if (value == null) return output;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output));
    return output;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, inner]) => {
      if (key === "a:t" || key === "#text") collectText(inner, output);
      else if (typeof inner === "object") collectText(inner, output);
    });
  }
  return output;
}

async function extractPptx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const parser = new XMLParser({ ignoreAttributes: true });
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slides = [];
  for (const slideName of slideNames) {
    const xml = await zip.files[slideName].async("string");
    const parsed = parser.parse(xml);
    const texts = collectText(parsed).filter((text, index, arr) => arr.indexOf(text) === index);
    if (texts.length) slides.push(`Slide ${slides.length + 1}\n${texts.join("\n")}`);
  }
  return { text: cleanText(slides.join("\n\n")), html: "" };
}

async function extractContentAtPath(filePath, kind) {
  if (["image", "audio", "video"].includes(kind)) return { text: "", html: "" };
  if (kind === "pdf") return extractPdf(filePath);
  if (kind === "doc") return extractDoc(filePath);
  if (kind === "docx") return extractDocx(filePath);
  if (kind === "pptx") return extractPptx(filePath);
  if (kind === "markdown" || kind === "text") {
    return { text: cleanText(fs.readFileSync(filePath, "utf8")), html: "" };
  }
  return { text: "", html: "" };
}

async function extractContentFromFile(file, kind) {
  return extractContentAtPath(path.join(uploadDir, file.filename), kind);
}

async function persistUploadedFile(file, role) {
  const id = crypto.randomUUID();
  const originalName = normalizeUploadedFilename(file.originalname);
  file.originalname = originalName;
  const kind = detectKind(file);
  let extractedText = "";
  let renderedHtml = "";
  try {
    const content = await extractContentFromFile(file, kind);
    extractedText = content.text;
    renderedHtml = content.html;
  } catch (error) {
    extractedText = `文件已上传，但文本提取失败：${error.message}`;
  }
  const createdAt = now();
  const summary = summarizeText(extractedText, originalName);

  db.prepare(`
    INSERT INTO files (
      id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, rendered_html, summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    role,
    originalName,
    file.filename,
    file.mimetype || "application/octet-stream",
    file.size,
    kind,
    extractedText,
    renderedHtml,
    summary,
    createdAt,
    createdAt
  );

  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), role === "primary" ? "Primary file" : "Context file", originalName, createdAt);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
}

function removeStoredFile(row) {
  if (!row) return;
  const filePath = path.join(uploadDir, row.stored_name);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Keep the database operation moving even if the file was already gone.
  }
}

async function refreshStoredFiles() {
  const rows = db.prepare("SELECT * FROM files").all();
  for (const row of rows) {
    const originalName = normalizeUploadedFilename(row.original_name);
    const kind = detectKindFromMetadata(originalName, row.mime_type, row.stored_name);
    const filePath = path.join(uploadDir, row.stored_name);
    let extractedText = row.extracted_text || "";
    let renderedHtml = row.rendered_html || "";

    if (
      fs.existsSync(filePath) &&
      (kind !== row.kind || !cleanText(extractedText) || (["doc", "docx"].includes(kind) && !cleanHtml(renderedHtml)))
    ) {
      try {
        const content = await extractContentAtPath(filePath, kind);
        extractedText = content.text;
        renderedHtml = content.html;
      } catch (error) {
        extractedText = `文件已上传，但文本提取失败：${error.message}`;
        renderedHtml = "";
      }
    }

    const summary = summarizeText(extractedText, originalName);
    if (
      originalName !== row.original_name ||
      kind !== row.kind ||
      extractedText !== row.extracted_text ||
      renderedHtml !== row.rendered_html ||
      summary !== row.summary
    ) {
      db.prepare(`
        UPDATE files
        SET original_name = ?, kind = ?, extracted_text = ?, rendered_html = ?, summary = ?, updated_at = ?
        WHERE id = ?
      `).run(originalName, kind, extractedText, renderedHtml, summary, now(), row.id);
    }
  }
}

function getFiles() {
  return db.prepare("SELECT * FROM files ORDER BY role = 'primary' DESC, created_at DESC").all().map(rowToFile);
}

function getNotes() {
  return db.prepare("SELECT * FROM notes ORDER BY created_at DESC").all().map((row) => ({
    id: row.id,
    kind: row.kind,
    text: row.text,
    source: row.source,
    createdAt: row.created_at
  }));
}

function getActivities() {
  return db.prepare("SELECT * FROM activities ORDER BY created_at DESC LIMIT 12").all().map((row) => ({
    id: row.id,
    label: row.label,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

function getRecords() {
  return db.prepare("SELECT * FROM discussion_records ORDER BY created_at DESC").all().map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    noteCount: row.note_count,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at
  }));
}

function getDiscussionInputs(limit = 24) {
  return db.prepare("SELECT * FROM discussion_inputs ORDER BY created_at DESC LIMIT ?").all(limit).map((row) => ({
    id: row.id,
    text: row.text,
    source: row.source,
    createdAt: row.created_at
  }));
}

function memoryLabel(kind) {
  return { point: "要点", decision: "结论", question: "问题", action: "行动" }[kind] || "记录";
}

function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || "";
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
}

function deleteSetting(key) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

function getOpenAiApiKey() {
  return cleanText(getSetting("openai_api_key")) || cleanText(process.env.OPENAI_API_KEY || "");
}

function getSettingsState() {
  const localKey = cleanText(getSetting("openai_api_key"));
  const envKey = cleanText(process.env.OPENAI_API_KEY || "");
  return {
    openaiApiKeyConfigured: Boolean(localKey || envKey),
    openaiApiKeySource: localKey ? "local" : envKey ? "env" : "none"
  };
}

function getDiscussionTopic() {
  return cleanText(getSetting("discussion_topic"));
}

refreshStoredFiles().catch((error) => {
  console.error("Failed to refresh stored files", error);
});

function buildDiscussionContext() {
  const primaryFiles = db.prepare("SELECT * FROM files WHERE role = 'primary' ORDER BY created_at DESC LIMIT 8").all().map(rowToFile);
  const contextFiles = db.prepare("SELECT * FROM files WHERE role = 'context' ORDER BY created_at DESC LIMIT 12").all().map(rowToFile);
  const memoryNotes = getNotes().slice(0, 24).reverse();
  const discussionInputs = getDiscussionInputs(24).reverse();
  const discussionTopic = getDiscussionTopic();
  const recentActivities = getActivities().slice(0, 8).reverse();
  const primaryText = primaryFiles
    .map((file) => `【${file.originalName}】\n${file.extractedText.slice(0, 2500)}`)
    .join("\n\n");
  const context = contextFiles
    .map((file) => `- ${file.originalName}: ${file.summary}`)
    .join("\n");
  const memory = memoryNotes
    .map((note) => `- ${shortLocalTime(note.createdAt)}｜${memoryLabel(note.kind)}｜${note.source || "讨论"}：${note.text}`)
    .join("\n");
  const activityMemory = recentActivities
    .map((activity) => `- ${shortLocalTime(activity.createdAt)}｜${activity.label}：${activity.detail}`)
    .join("\n");
  const typedContext = discussionInputs
    .map((input) => `- ${shortLocalTime(input.createdAt)}｜${input.source === "user" ? "用户输入" : "AI"}：${input.text}`)
    .join("\n");
  return [
    "你是 Discuz，一个用于本地文件语音讨论的 AI 伙伴。你的对话必须紧密围绕当前主讨论文件、用户给出的背景材料和用户刚刚提出的问题。",
    "默认讨论对象是当前打开的主题文件、前台弹出的预览窗口和白板。除非用户明确要求讨论其他资源文件，或当前信息确实不足，否则不要主动把讨论焦点切到其他文件。",
    "讨论主题不只来自主题文件，也来自用户在底部输入框提交的主题、观点、问题和链接。用户的文字输入优先级很高，要把它当作当前讨论指令的一部分。",
    "随着讨论深入，如果你判断已经形成更准确的讨论主题，必须调用 propose_discussion_topic 请用户确认。若你发现用户正在严重偏离已确认主题，也要调用 propose_discussion_topic 提醒用户，并说明是继续原主题还是确认更换主题。",
    "如果收到系统事件提示当前主题文件已被删除，你必须立即停止基于该文件继续分析，并询问用户是停止此主题的讨论，还是更换新的讨论主题/上传新的主题文件。",
    "每次重新打开语音时，你必须先读取下面的讨论记忆，承接此前已经形成的要点、结论、问题和行动项。不要让用户重复已经讨论过的背景；如果记忆和当前文件冲突，以当前文件为准并说明差异。",
    "记录窗口保存的是讨论要点，不是逐句转写。不要把自己或用户的原话逐句写入记录；只有在形成一个完整观点、阶段性结论、待确认问题或行动项后，才调用 save_discussion_note 保存一段简洁总结。每条记录应是一小段话，优先概括“讨论了什么、形成了什么判断、下一步是什么”。",
    "你可以按需调用工具打开白板、临时草稿、媒体窗口，或打开某个主题/资源文件的重点预览窗口辅助讨论。临时窗口用于当次讨论，关闭后视为临时内容；只有用户明确要求保存时，才把内容作为成果或资源延续。",
    "不要泛泛而谈，不要把话题扩展到无关方向。每次回复优先给出中肯、可执行、能推进讨论的意见。",
    "如果信息不足，先指出缺口，再建议用户补充哪类材料。需要资料时，优先调用本地背景材料检索；本地资料不足时，再调用联网搜索。",
    "引用资料时必须说明来源文件名或网页标题。你的默认任务是提炼关键观点、结论、争议点、风险和下一步，不主动修改原文件。",
    discussionTopic ? `已确认讨论主题：${discussionTopic}` : "当前还没有用户确认的讨论主题。",
    typedContext ? `用户文字输入与链接：\n${typedContext}` : "当前还没有用户文字输入。",
    primaryFiles.length ? `主讨论文件：\n${primaryText}` : "当前还没有主讨论文件。",
    context ? `背景材料摘要：\n${context}` : "当前还没有背景材料。",
    memory ? `讨论记忆（重连后优先承接）：\n${memory}` : "当前还没有已保存的讨论记忆。",
    activityMemory ? `最近工作状态：\n${activityMemory}` : "当前还没有最近工作状态。"
  ].join("\n\n");
}

function shortLocalTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Shanghai"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function extractDuckDuckGoResults(html) {
  const blocks = html.split(/<div class="result results_links_deep web-result">|<div class="result">/g).slice(1);
  return blocks.map((block) => {
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    if (!linkMatch) return null;
    const url = decodeHtml(linkMatch[1]).replace(/^\/l\/\?uddg=([^&]+).*$/, (_all, encoded) => decodeURIComponent(encoded));
    const title = stripTags(decodeHtml(linkMatch[2]));
    const snippet = stripTags(decodeHtml(snippetMatch?.[1] || snippetMatch?.[2] || ""));
    return { title, url, snippet, source: "web" };
  }).filter(Boolean).slice(0, 6);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return cleanText(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s{2,}/g, " ");
}

app.get("/api/state", (_req, res) => {
  res.json({
    files: getFiles(),
    notes: getNotes(),
    records: getRecords(),
    discussionInputs: getDiscussionInputs(),
    discussionTopic: getDiscussionTopic(),
    activities: getActivities(),
    settings: getSettingsState()
  });
});

app.post("/api/discussion-inputs", (req, res) => {
  const text = cleanText(req.body?.text || "");
  if (!text) return res.status(400).json({ error: "Missing discussion input" });
  const createdAt = now();
  db.prepare("INSERT INTO discussion_inputs (id, text, source, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), text, "user", createdAt);
  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), "Discussion input", text.slice(0, 80), createdAt);
  res.json({ discussionInputs: getDiscussionInputs(), activities: getActivities() });
});

app.post("/api/discussion-topic", (req, res) => {
  const topic = cleanText(req.body?.topic || "");
  if (!topic) return res.status(400).json({ error: "Missing discussion topic" });
  setSetting("discussion_topic", topic);
  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), "Discussion topic", topic.slice(0, 80), now());
  res.json({ discussionTopic: getDiscussionTopic(), activities: getActivities() });
});

app.delete("/api/files/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  removeStoredFile(row);
  db.prepare("DELETE FROM files WHERE id = ?").run(req.params.id);
  const createdAt = now();
  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), row.role === "primary" ? "Primary removed" : "Resource removed", row.original_name, createdAt);
  res.json({ files: getFiles(), activities: getActivities() });
});

app.post("/api/discussion/reset", (_req, res) => {
  db.prepare("SELECT * FROM files").all().forEach(removeStoredFile);
  db.exec(`
    DELETE FROM files;
    DELETE FROM notes;
    DELETE FROM discussion_inputs;
    DELETE FROM activities;
    DELETE FROM settings WHERE key = 'discussion_topic';
  `);
  res.json({
    files: getFiles(),
    notes: getNotes(),
    records: getRecords(),
    discussionInputs: getDiscussionInputs(),
    discussionTopic: getDiscussionTopic(),
    activities: getActivities(),
    settings: getSettingsState()
  });
});

app.get("/api/settings", (_req, res) => {
  res.json(getSettingsState());
});

app.post("/api/settings/openai-key", (req, res) => {
  const apiKey = cleanText(req.body?.apiKey || "");
  if (apiKey) setSetting("openai_api_key", apiKey);
  else deleteSetting("openai_api_key");
  res.json(getSettingsState());
});

app.post("/api/files/primary", upload.array("files", 20), async (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: "Missing files" });
  const files = [];
  for (const file of uploaded) files.push(await persistUploadedFile(file, "primary"));
  res.json({ uploaded: files, file: files[0], files: getFiles(), activities: getActivities() });
});

app.post("/api/files/context", upload.array("files", 20), async (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: "Missing files" });
  const files = [];
  for (const file of uploaded) files.push(await persistUploadedFile(file, "context"));
  res.json({ uploaded: files, files: getFiles(), activities: getActivities() });
});

app.get("/api/files/:id/preview", (req, res) => {
  const file = rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id));
  if (!file) return res.status(404).json({ error: "File not found" });
  res.json(file);
});

app.get("/api/context/search", (req, res) => {
  const query = cleanText(req.query.q || "").toLowerCase();
  const rows = db.prepare("SELECT * FROM files WHERE role = 'context'").all();
  const terms = query.split(/\s+/).filter(Boolean);
  const results = rows
    .map((row) => {
      const text = `${row.original_name}\n${row.extracted_text || row.summary}`;
      const lower = text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      const firstHit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
      const snippet = cleanText(text.slice(Math.max(0, firstHit - 120), firstHit + 360));
      return { file: rowToFile(row), score, snippet };
    })
    .filter((item) => !terms.length || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  res.json({ query, results });
});

app.get("/api/web/search", async (req, res) => {
  const query = cleanText(req.query.q || "");
  if (!query) return res.json({ query, results: [] });
  try {
    const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Discuz/0.1 local discussion assistant"
      }
    });
    const html = await response.text();
    let results = extractDuckDuckGoResults(html);
    if (!results.length) {
      const wikiResponse = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srsearch=${encodeURIComponent(query)}`);
      const wikiPayload = await wikiResponse.json();
      results = (wikiPayload.query?.search || []).slice(0, 6).map((item) => ({
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
        snippet: stripTags(decodeHtml(item.snippet)),
        source: "wikipedia"
      }));
    }
    db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), "Web", query, now());
    res.json({ query, results });
  } catch (error) {
    res.status(502).json({ error: error.message, query, results: [] });
  }
});

app.post("/api/notes", (req, res) => {
  const { kind = "point", text, source = "" } = req.body || {};
  if (!cleanText(text)) return res.status(400).json({ error: "Missing note text" });
  const createdAt = now();
  db.prepare("INSERT INTO notes (id, kind, text, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), kind, cleanText(text), cleanText(source), createdAt);
  res.json({ notes: getNotes() });
});

app.post("/api/records/finish", (req, res) => {
  const startedAt = cleanText(req.body?.startedAt || "");
  if (!startedAt) return res.status(400).json({ error: "Missing startedAt" });
  const endedAt = now();
  const notes = db.prepare(`
    SELECT * FROM notes
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `).all(startedAt, endedAt);
  if (!notes.length) return res.json({ created: null, records: getRecords(), activities: getActivities() });

  const content = notes
    .map((note) => `【${memoryLabel(note.kind)}】${cleanText(note.text)}`)
    .join("\n\n");
  const firstText = cleanText(notes[0].text);
  const titleBase = firstText || `讨论记录 ${shortLocalTime(endedAt)}`;
  const title = titleBase.length > 30 ? `${titleBase.slice(0, 30)}...` : titleBase;
  const id = crypto.randomUUID();
  const createdAt = endedAt;

  db.prepare(`
    INSERT INTO discussion_records (id, title, content, note_count, started_at, ended_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, content, notes.length, startedAt, endedAt, createdAt);
  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), "Record", title, createdAt);

  res.json({
    created: getRecords().find((record) => record.id === id),
    records: getRecords(),
    activities: getActivities()
  });
});

app.post("/api/realtime/session", async (req, res) => {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
  }
  if (!req.body || typeof req.body !== "string") {
    return res.status(400).json({ error: "Expected SDP body" });
  }

  const session = {
    type: "realtime",
    model: "gpt-realtime-2",
    instructions: buildDiscussionContext(),
    tools: [
      {
        type: "function",
        name: "search_context",
        description: "Search the user's local background materials for topic-relevant evidence. Use before answering questions that require document context.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A focused search query about the current topic." }
          },
          required: ["query"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "web_search",
        description: "Search the public web when local materials are insufficient. Use sparingly and bring the answer back to the current discussion topic.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A focused web search query." }
          },
          required: ["query"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "set_layout",
        description: "Adjust the Discuz discussion workspace layout by voice, including focusing or fullscreening one panel.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["topic", "resources", "record", "reset"] },
            mode: { type: "string", enum: ["focus", "fullscreen", "reset"] }
          },
          required: ["target", "mode"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "open_discussion_tool",
        description: "Open a temporary frontmost tool for discussion, such as whiteboard, document draft, image viewer, video viewer, or audio player.",
        parameters: {
          type: "object",
          properties: {
            tool: { type: "string", enum: ["whiteboard", "draft", "image", "video", "audio"] },
            title: { type: "string" }
          },
          required: ["tool"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "open_file_preview",
        description: "Open a frontmost preview window for a topic or resource file when it should become the focused discussion object.",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["primary", "context"], description: "primary for topic files, context for resource files." },
            query: { type: "string", description: "Optional part of the filename to open. Leave empty to open the first matching file." }
          },
          required: ["role"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "save_discussion_note",
        description: "Save a concise paragraph summary of a completed discussion point. Do not use this for verbatim transcript or sentence-by-sentence notes.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["point", "decision", "question", "action"],
              description: "The type of summarized discussion note."
            },
            text: {
              type: "string",
              description: "A concise paragraph in Chinese summarizing the completed point, conclusion, open question, or action item."
            }
          },
          required: ["kind", "text"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "propose_discussion_topic",
        description: "Ask the user to confirm a clearer discussion topic, or warn that the discussion is drifting and ask whether to switch topics.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The proposed discussion topic in concise Chinese."
            },
            reason: {
              type: "string",
              description: "Why this topic should be confirmed, or why the current discussion appears to be drifting."
            },
            intent: {
              type: "string",
              enum: ["confirm", "drift"],
              description: "Use confirm for a better topic name; use drift when reminding the user about serious topic drift."
            }
          },
          required: ["title", "reason", "intent"],
          additionalProperties: false
        }
      }
    ],
    tool_choice: "auto",
    audio: {
      output: { voice: "marin" }
    }
  };
  const fd = new FormData();
  fd.set("sdp", req.body);
  fd.set("session", JSON.stringify(session));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "OpenAI-Safety-Identifier": "discuz-local-user"
    },
    body: fd
  });

  const payload = await response.text();
  if (!response.ok) {
    return res.status(response.status).type("text/plain").send(payload);
  }
  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), "Realtime", "Voice session started", now());
  res.type("application/sdp").send(payload);
});

app.listen(port, () => {
  console.log(`Discuz server listening on http://localhost:${port}`);
});

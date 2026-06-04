import "dotenv/config";
import cors from "cors";
import express from "express";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import multer from "multer";
import mammoth from "mammoth";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);
const officeConverterCandidates = [
  process.env.LIBREOFFICE_PATH,
  "/opt/homebrew/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "soffice",
  "libreoffice"
].filter(Boolean);
let cachedOfficeConverter;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const clientDistDir = path.join(rootDir, "dist");
const dataDir = path.join(rootDir, "data");
const legacyUploadDir = path.join(dataDir, "uploads");
const topicsDir = path.join(dataDir, "topics");
const diagnosticsDir = path.join(dataDir, "diagnostics");
const dbPath = path.join(dataDir, "discuz.sqlite");
const port = Number(process.env.PORT || 8787);
const defaultImageGenerationModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
const aiSettingsDefaults = {
  assistantName: "Discuz",
  realtimeModel: "gpt-realtime-2",
  realtimeVoice: "shimmer",
  transcriptionModel: "gpt-4o-transcribe",
  imageModel: defaultImageGenerationModel,
  imageQuality: "high",
  webSearchProviders: "brave,bing,google,serpapi,tavily,duckduckgo,wikipedia"
};
const webSearchProviders = ["brave", "bing", "google", "serpapi", "tavily", "duckduckgo", "wikipedia"];
const webSearchSecretSettings = {
  brave: { setting: "web_search_brave_api_key", env: ["BRAVE_SEARCH_API_KEY"] },
  bing: { setting: "web_search_bing_api_key", env: ["BING_SEARCH_API_KEY"] },
  google: { setting: "web_search_google_api_key", env: ["GOOGLE_SEARCH_API_KEY", "GOOGLE_API_KEY"] },
  googleEngine: { setting: "web_search_google_engine_id", env: ["GOOGLE_SEARCH_ENGINE_ID", "GOOGLE_CSE_ID"] },
  serpapi: { setting: "web_search_serpapi_api_key", env: ["SERPAPI_API_KEY"] },
  tavily: { setting: "web_search_tavily_api_key", env: ["TAVILY_API_KEY"] }
};

fs.mkdirSync(legacyUploadDir, { recursive: true });
fs.mkdirSync(topicsDir, { recursive: true });
fs.mkdirSync(diagnosticsDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,
    extracted_text TEXT NOT NULL DEFAULT '',
    rendered_html TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    extraction_status TEXT NOT NULL DEFAULT 'complete',
    extraction_error TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussion_records (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    note_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussion_inputs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussion_directions (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    folder_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const fileColumns = db.prepare("PRAGMA table_info(files)").all().map((column) => column.name);
if (!fileColumns.includes("topic_id")) {
  db.exec("ALTER TABLE files ADD COLUMN topic_id TEXT NOT NULL DEFAULT ''");
}
if (!fileColumns.includes("rendered_html")) {
  db.exec("ALTER TABLE files ADD COLUMN rendered_html TEXT NOT NULL DEFAULT ''");
}
if (!fileColumns.includes("extraction_status")) {
  db.exec("ALTER TABLE files ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'complete'");
}
if (!fileColumns.includes("extraction_error")) {
  db.exec("ALTER TABLE files ADD COLUMN extraction_error TEXT NOT NULL DEFAULT ''");
}
if (!fileColumns.includes("sort_order")) {
  db.exec("ALTER TABLE files ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
}
addColumnIfMissing("notes", "topic_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("discussion_records", "topic_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("discussion_inputs", "topic_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("meeting_messages", "topic_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("discussion_directions", "topic_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("activities", "topic_id", "TEXT NOT NULL DEFAULT ''");

function createTopicRecord(title = "") {
  const id = crypto.randomUUID();
  const createdAt = now();
  const safeTitle = cleanText(title) || `新讨论 ${shortLocalTime(createdAt)}`;
  db.prepare("INSERT INTO topics (id, title, folder_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, safeTitle, id, createdAt, createdAt);
  fs.mkdirSync(topicUploadDir(id), { recursive: true });
  return db.prepare("SELECT * FROM topics WHERE id = ?").get(id);
}

function ensureActiveTopic() {
  let activeId = cleanText(getSetting("active_topic_id"));
  let activeTopic = activeId ? db.prepare("SELECT * FROM topics WHERE id = ?").get(activeId) : null;
  if (!activeTopic) {
    activeTopic = db.prepare("SELECT * FROM topics ORDER BY updated_at DESC, created_at DESC LIMIT 1").get();
  }
  if (!activeTopic) {
    const title = cleanText(getSetting("discussion_topic")) || "默认讨论";
    activeTopic = createTopicRecord(title);
  }
  setSetting("active_topic_id", activeTopic.id);
  db.prepare("UPDATE files SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  db.prepare("UPDATE notes SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  db.prepare("UPDATE discussion_records SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  db.prepare("UPDATE discussion_inputs SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  db.prepare("UPDATE meeting_messages SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  db.prepare("UPDATE discussion_directions SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  db.prepare("UPDATE activities SET topic_id = ? WHERE topic_id = ''").run(activeTopic.id);
  migrateLegacyFilesToTopic(activeTopic.id);
  return activeTopic.id;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, currentTopicUploadDir()),
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
app.use(express.json({ limit: "2mb" }));
app.get("/api/raw/:topicId/:storedName", (req, res) => {
  const topicId = cleanText(req.params.topicId);
  const storedName = path.basename(cleanText(req.params.storedName));
  const filePath = path.join(topicUploadDir(topicId), storedName);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  const legacyPath = path.join(legacyUploadDir, storedName);
  if (fs.existsSync(legacyPath)) return res.sendFile(legacyPath);
  res.status(404).json({ error: "File not found" });
});
app.use("/api/raw", express.static(legacyUploadDir));

function now() {
  return new Date().toISOString();
}

function safeDiagnosticSessionId(value) {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return cleaned || "default";
}

function diagnosticEventLimit(event) {
  const json = JSON.stringify(event ?? {});
  if (json.length <= 8000) return event;
  return {
    at: event?.at || now(),
    kind: event?.kind || "oversized",
    detail: {
      truncated: true,
      preview: json.slice(0, 8000)
    }
  };
}

function diagnosticFilePath(sessionId) {
  return path.join(diagnosticsDir, `${safeDiagnosticSessionId(sessionId)}.jsonl`);
}

function nextFileSortOrder(role, topicId = getActiveTopicId()) {
  const row = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM files WHERE role = ? AND topic_id = ?").get(role, topicId);
  return Number(row?.next_order ?? 0);
}

function normalizePrimarySortOrder(topicId = getActiveTopicId()) {
  const rows = db.prepare(`
    SELECT id FROM files
    WHERE role = 'primary' AND topic_id = ?
    ORDER BY sort_order ASC, created_at DESC
  `).all(topicId);
  const update = db.prepare("UPDATE files SET sort_order = ? WHERE id = ?");
  rows.forEach((row, index) => update.run(index, row.id));
}

ensureActiveTopic();
normalizePrimarySortOrder();

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

function filenameFromContentDisposition(value) {
  const text = String(value || "");
  const encoded = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/["']/g, ""));
    } catch {
      return encoded.replace(/["']/g, "");
    }
  }
  return text.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] || "";
}

function filenameFromUrl(url, contentType = "", contentDisposition = "") {
  const dispositionName = filenameFromContentDisposition(contentDisposition);
  if (dispositionName) return normalizeUploadedFilename(dispositionName);
  try {
    const parsed = new URL(url);
    const leaf = decodeURIComponent(path.basename(parsed.pathname));
    if (leaf && leaf !== "/" && path.extname(leaf)) return normalizeUploadedFilename(leaf);
  } catch {
    // Fall through to a content-type based filename.
  }
  if (String(contentType).includes("pdf")) return "网页导入文件.pdf";
  return "网页导入文件";
}

function rowToFile(row) {
  if (!row) return null;
  const topicId = cleanText(row.topic_id) || getActiveTopicId();
  return {
    id: row.id,
    topicId,
    role: row.role,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind,
    extractedText: row.extracted_text,
    renderedHtml: row.rendered_html,
    summary: row.summary,
    extractionStatus: row.extraction_status || "complete",
    extractionError: row.extraction_error || "",
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    previewUrl: `/api/raw/${encodeURIComponent(topicId)}/${encodeURIComponent(row.stored_name)}`
  };
}

function detectKindFromMetadata(originalName, mimeType = "", storedName = "") {
  const ext = path.extname(originalName || storedName).toLowerCase() || path.extname(storedName).toLowerCase();
  const mime = mimeType || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime === "application/epub+zip" || ext === ".epub") return "epub";
  if (mime === "application/msword" || ext === ".doc") return "doc";
  if (ext === ".docx") return "docx";
  if (mime === "application/vnd.ms-powerpoint" || ext === ".ppt") return "ppt";
  if (ext === ".pptx") return "pptx";
  if (mime === "application/vnd.ms-excel" || [".xlsx", ".xlsm", ".xls", ".csv", ".tsv"].includes(ext)) return "spreadsheet";
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".txt", ".json", ".log", ".xml", ".html", ".css", ".js", ".ts", ".tsx", ".jsx"].includes(ext)) return "text";
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function entityCodePoint(value, radix = 10) {
  const codePoint = parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return " ";
  }
}

async function resolveOfficeConverter() {
  if (cachedOfficeConverter !== undefined) return cachedOfficeConverter;
  for (const candidate of officeConverterCandidates) {
    try {
      if (path.isAbsolute(candidate)) {
        if (fs.existsSync(candidate)) {
          cachedOfficeConverter = candidate;
          return cachedOfficeConverter;
        }
        continue;
      }
      const result = await execFileAsync("which", [candidate], { maxBuffer: 1024 * 1024 });
      const resolved = cleanText(result.stdout).split("\n")[0];
      if (resolved) {
        cachedOfficeConverter = resolved;
        return cachedOfficeConverter;
      }
    } catch {
      // Try the next known LibreOffice command name/location.
    }
  }
  cachedOfficeConverter = null;
  return cachedOfficeConverter;
}

async function extractConvertedLegacyOffice(filePath, targetExtension, label, extractor) {
  const command = await resolveOfficeConverter();
  if (!command) {
    throw new Error(`无法解析旧版 ${label}：未找到 LibreOffice/soffice 转换器。`);
  }

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "discuz-office-"));
  try {
    const target = targetExtension.replace(/^\./, "");
    await execFileAsync(command, ["--headless", "--convert-to", target, "--outdir", outputDir, filePath], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 90_000
    });
    const convertedName = fs.readdirSync(outputDir)
      .find((name) => path.extname(name).toLowerCase() === `.${target.toLowerCase()}`);
    if (!convertedName) {
      throw new Error(`LibreOffice 未生成 ${target} 转换结果。`);
    }
    return await extractor(path.join(outputDir, convertedName));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function topicUploadDir(topicId) {
  const safeId = path.basename(cleanText(topicId) || "default");
  return path.join(topicsDir, safeId, "uploads");
}

function currentTopicUploadDir() {
  const dir = topicUploadDir(getActiveTopicId());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePathForRow(row) {
  const topicPath = path.join(topicUploadDir(cleanText(row?.topic_id) || getActiveTopicId()), path.basename(row.stored_name));
  if (fs.existsSync(topicPath)) return topicPath;
  return path.join(legacyUploadDir, path.basename(row.stored_name));
}

function rowToTopic(row) {
  if (!row) return null;
  const fileCount = db.prepare("SELECT COUNT(*) AS count FROM files WHERE topic_id = ?").get(row.id)?.count ?? 0;
  const recordCount = db.prepare("SELECT COUNT(*) AS count FROM discussion_records WHERE topic_id = ?").get(row.id)?.count ?? 0;
  return {
    id: row.id,
    title: row.title,
    folderName: row.folder_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fileCount,
    recordCount,
    active: row.id === getActiveTopicId()
  };
}

function getActiveTopicId() {
  const activeId = cleanText(getSetting("active_topic_id"));
  const activeTopic = activeId ? db.prepare("SELECT id FROM topics WHERE id = ?").get(activeId) : null;
  if (activeTopic) return activeTopic.id;
  return ensureActiveTopic();
}

function getActiveTopic() {
  return db.prepare("SELECT * FROM topics WHERE id = ?").get(getActiveTopicId());
}

function getTopics() {
  return db.prepare("SELECT * FROM topics ORDER BY updated_at DESC, created_at DESC").all().map(rowToTopic);
}

function touchActiveTopic() {
  db.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(now(), getActiveTopicId());
}

function migrateLegacyFilesToTopic(topicId) {
  const rows = db.prepare("SELECT * FROM files WHERE topic_id = ?").all(topicId);
  const dir = topicUploadDir(topicId);
  fs.mkdirSync(dir, { recursive: true });
  for (const row of rows) {
    const legacyPath = path.join(legacyUploadDir, row.stored_name);
    const targetPath = path.join(dir, row.stored_name);
    if (fs.existsSync(legacyPath) && !fs.existsSync(targetPath)) {
      try {
        fs.renameSync(legacyPath, targetPath);
      } catch {
        try {
          fs.copyFileSync(legacyPath, targetPath);
        } catch {
          // Keep compatibility through the legacy raw route if migration fails.
        }
      }
    }
  }
}

function topicSnapshot(topicId = getActiveTopicId()) {
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  return {
    topic: rowToTopic(topic),
    files: db.prepare("SELECT * FROM files WHERE topic_id = ? ORDER BY created_at DESC").all(topicId).map(rowToFile),
    notes: db.prepare("SELECT * FROM notes WHERE topic_id = ? ORDER BY created_at DESC").all(topicId),
    records: db.prepare("SELECT * FROM discussion_records WHERE topic_id = ? ORDER BY created_at DESC").all(topicId),
    discussionInputs: db.prepare("SELECT * FROM discussion_inputs WHERE topic_id = ? ORDER BY created_at DESC").all(topicId),
    meetingMessages: db.prepare("SELECT * FROM meeting_messages WHERE topic_id = ? ORDER BY created_at DESC").all(topicId),
    directions: getDirections(topicId),
    activities: db.prepare("SELECT * FROM activities WHERE topic_id = ? ORDER BY created_at DESC").all(topicId)
  };
}

function writeTopicSnapshot(topicId = getActiveTopicId()) {
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  if (!topic) return;
  const topicDir = path.join(topicsDir, topic.folder_name);
  fs.mkdirSync(topicDir, { recursive: true });
  fs.writeFileSync(path.join(topicDir, "topic.json"), JSON.stringify(topicSnapshot(topicId), null, 2), "utf8");
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

function compactPromptText(value, maxChars) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trimEnd()}...`;
}

function compactFilePromptLine(file, maxChars = 900) {
  const status = file.extractionStatus && file.extractionStatus !== "complete" ? `｜${file.extractionStatus}` : "";
  const summary = compactPromptText(file.summary, 260);
  const excerpt = compactPromptText(file.extractedText, maxChars);
  const text = summary && excerpt && !excerpt.startsWith(summary)
    ? `${summary} 片段：${excerpt}`
    : summary || excerpt || "暂无可读摘要。";
  return `- ${file.originalName}｜${file.kind}${status}: ${compactPromptText(text, maxChars)}`;
}

function rowToCompactFile(row) {
  const file = rowToFile(row);
  if (!file) return null;
  return {
    id: file.id,
    name: file.originalName,
    role: file.role,
    kind: file.kind,
    summary: compactPromptText(file.summary || file.extractedText, 240),
    extractionStatus: file.extractionStatus,
    previewUrl: file.previewUrl
  };
}

async function extractPdf(filePath) {
  const { PDFParse } = await import("pdf-parse");
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });
  try {
    const result = await parser.getText();
    return { text: cleanText(result.text), html: "" };
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(filePath) {
  const [rawText, html] = await Promise.all([
    mammoth.extractRawText({ path: filePath }),
    mammoth.convertToHtml({ path: filePath })
  ]);
  return { text: cleanText(rawText.value), html: cleanHtml(html.value) };
}

async function extractDoc(filePath) {
  try {
    const [text, html] = await Promise.all([
      execFileAsync("textutil", ["-convert", "txt", "-stdout", filePath], { maxBuffer: 20 * 1024 * 1024 }),
      execFileAsync("textutil", ["-convert", "html", "-stdout", filePath], { maxBuffer: 50 * 1024 * 1024 })
    ]);
    return { text: cleanText(text.stdout), html: cleanHtml(html.stdout) };
  } catch {
    return extractConvertedLegacyOffice(filePath, "docx", "Word .doc", extractDocx);
  }
}

function stripHtmlToText(value = "") {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => entityCodePoint(code))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => entityCodePoint(code, 16));
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

function zipPathDir(filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index + 1) : "";
}

function resolveZipPath(baseDir, target = "") {
  const rawTarget = String(target || "").split(/[?#]/)[0];
  let decodedTarget = rawTarget;
  try {
    decodedTarget = decodeURIComponent(rawTarget);
  } catch {
    decodedTarget = rawTarget;
  }
  const normalizedTarget = decodedTarget.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = `${baseDir || ""}${normalizedTarget}`.split("/");
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

async function extractEpub(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const containerXml = zip.files["META-INF/container.xml"] ? await zip.files["META-INF/container.xml"].async("string") : "";
  const container = containerXml ? parser.parse(containerXml) : {};
  const rootfile = asArray(container?.container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.["@_full-path"] || Object.keys(zip.files).find((name) => /\.opf$/i.test(name));
  if (!opfPath || !zip.files[opfPath]) {
    throw new Error("无法解析 EPUB：未找到 OPF 目录文件。");
  }
  const opfXml = await zip.files[opfPath].async("string");
  const opf = parser.parse(opfXml);
  const opfDir = zipPathDir(opfPath);
  const manifestItems = asArray(opf?.package?.manifest?.item);
  const manifest = new Map(manifestItems.map((item) => [item?.["@_id"], item]));
  const spine = asArray(opf?.package?.spine?.itemref)
    .map((item) => manifest.get(item?.["@_idref"]))
    .filter(Boolean);
  const readingItems = spine.length
    ? spine
    : manifestItems.filter((item) => /xhtml|html/i.test(`${item?.["@_media-type"] || ""}`) || /\.x?html?$/i.test(`${item?.["@_href"] || ""}`));
  const title = cleanText(collectText(opf?.package?.metadata?.["dc:title"] ?? opf?.package?.metadata?.title, []).join(" "));
  const sections = [];
  const htmlParts = [];
  let totalChars = 0;
  const maxChars = 100000;
  for (const item of readingItems) {
    if (totalChars >= maxChars) break;
    const href = item?.["@_href"];
    if (!href) continue;
    const chapterPath = resolveZipPath(opfDir, href);
    const chapterFile = zip.files[chapterPath];
    if (!chapterFile) continue;
    const rawHtml = await chapterFile.async("string");
    const chapterTitle = cleanText(stripHtmlToText(rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""));
    const text = cleanText(stripHtmlToText(rawHtml));
    if (!text) continue;
    const heading = chapterTitle || path.basename(chapterPath);
    const section = `${heading}\n${text}`.slice(0, Math.max(0, maxChars - totalChars));
    totalChars += section.length;
    sections.push(section);
    htmlParts.push(`<section><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p></section>`);
  }
  const text = cleanText([title ? `书名：${title}` : "", ...sections].join("\n\n"));
  return { text, html: cleanHtml(htmlParts.join("\n")) };
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

async function extractPpt(filePath) {
  return extractConvertedLegacyOffice(filePath, "pptx", "PowerPoint .ppt", extractPptx);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function columnNameToIndex(value = "") {
  return String(value || "").split("").reduce((sum, char) => sum * 26 + char.toUpperCase().charCodeAt(0) - 64, 0) - 1;
}

function cellRefToColumnIndex(ref = "") {
  const column = String(ref || "").match(/[A-Za-z]+/)?.[0] || "";
  return column ? columnNameToIndex(column) : -1;
}

function collectSharedStringText(value) {
  return collectText(value, []).join("");
}

function worksheetTargetPath(target = "") {
  const normalized = String(target || "").replace(/^\/+/, "");
  if (normalized.startsWith("xl/")) return normalized;
  return `xl/${normalized}`;
}

async function extractXlsx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const sharedStringsXml = zip.files["xl/sharedStrings.xml"] ? await zip.files["xl/sharedStrings.xml"].async("string") : "";
  const sharedStrings = sharedStringsXml
    ? asArray(parser.parse(sharedStringsXml)?.sst?.si).map(collectSharedStringText)
    : [];
  const workbookXml = zip.files["xl/workbook.xml"] ? await zip.files["xl/workbook.xml"].async("string") : "";
  const relsXml = zip.files["xl/_rels/workbook.xml.rels"] ? await zip.files["xl/_rels/workbook.xml.rels"].async("string") : "";
  const workbook = workbookXml ? parser.parse(workbookXml) : {};
  const rels = relsXml ? parser.parse(relsXml) : {};
  const relMap = new Map(asArray(rels?.Relationships?.Relationship).map((rel) => [rel?.["@_Id"], worksheetTargetPath(rel?.["@_Target"])]));
  const workbookSheets = asArray(workbook?.workbook?.sheets?.sheet);
  const sheetEntries = workbookSheets.length
    ? workbookSheets.map((sheet) => ({
      name: cleanText(sheet?.["@_name"] || "Sheet"),
      path: relMap.get(sheet?.["@_r:id"])
    }))
    : Object.keys(zip.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1] || 0) - Number(b.match(/sheet(\d+)/)?.[1] || 0))
      .map((name, index) => ({ name: `Sheet${index + 1}`, path: name }));
  const sections = [];
  let totalChars = 0;
  const maxChars = 70000;
  for (const sheet of sheetEntries) {
    if (!sheet.path || !zip.files[sheet.path] || totalChars >= maxChars) continue;
    const xml = await zip.files[sheet.path].async("string");
    const parsed = parser.parse(xml);
    const rows = asArray(parsed?.worksheet?.sheetData?.row);
    const renderedRows = [];
    for (const row of rows.slice(0, 220)) {
      const cells = [];
      for (const cell of asArray(row?.c).slice(0, 40)) {
        const columnIndex = cellRefToColumnIndex(cell?.["@_r"]);
        while (cells.length < Math.max(0, columnIndex)) cells.push("");
        let value = "";
        if (cell?.["@_t"] === "s") value = sharedStrings[Number(cell?.v)] || "";
        else if (cell?.["@_t"] === "inlineStr") value = collectSharedStringText(cell?.is);
        else if (cell?.["@_t"] === "b") value = String(cell?.v) === "1" ? "TRUE" : "FALSE";
        else if (cell?.f != null && cell?.v == null) value = `=${collectText(cell.f, []).join("")}`;
        else value = cleanText(cell?.v ?? "");
        cells.push(cleanText(value));
      }
      const usefulCells = cells.map((item) => item.trim()).filter(Boolean);
      if (usefulCells.length) renderedRows.push(cells.join(" | ").replace(/\s+\|/g, " |").replace(/\|\s+/g, "| "));
      if (renderedRows.length >= 120) break;
    }
    const truncatedRows = rows.length > 120 ? `\n... 已截取前 120 行，共 ${rows.length} 行。` : "";
    const section = `工作表：${sheet.name}\n${renderedRows.join("\n") || "（空工作表）"}${truncatedRows}`;
    totalChars += section.length;
    sections.push(section);
  }
  return { text: cleanText(sections.join("\n\n").slice(0, maxChars)), html: "" };
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function extractDelimitedSpreadsheet(filePath, delimiter, label) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = parseDelimitedRows(text, delimiter).slice(0, 160);
  const rendered = rows
    .map((row) => row.slice(0, 40).map((cell) => cleanText(cell)).join(" | "))
    .filter((row) => row.replace(/[|\s]/g, ""));
  const rowCount = parseDelimitedRows(text, delimiter).length;
  const truncated = rowCount > 160 ? `\n... 已截取前 160 行，共 ${rowCount} 行。` : "";
  return { text: cleanText(`${label}\n${rendered.join("\n")}${truncated}`), html: "" };
}

async function extractSpreadsheet(filePath, metadata = {}) {
  const ext = path.extname(metadata.originalName || filePath).toLowerCase();
  const mime = metadata.mimeType || "";
  if (ext === ".xlsx" || ext === ".xlsm") return extractXlsx(filePath);
  if (ext === ".xls" || mime === "application/vnd.ms-excel") {
    return extractConvertedLegacyOffice(filePath, "xlsx", "Excel .xls", extractXlsx);
  }
  if (ext === ".csv") return extractDelimitedSpreadsheet(filePath, ",", "CSV 表格");
  if (ext === ".tsv") return extractDelimitedSpreadsheet(filePath, "\t", "TSV 表格");
  return {
    text: "已识别为 Excel 表格，但当前仅支持直接读取 .xlsx、.xlsm、.csv、.tsv，并通过 LibreOffice 转换读取旧版 .xls。",
    html: ""
  };
}

function responseOutputText(payload) {
  if (typeof payload?.output_text === "string") return cleanText(payload.output_text);
  const parts = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;
    if ((value.type === "output_text" || value.type === "text") && typeof value.text === "string") {
      parts.push(value.text);
      return;
    }
    if (Array.isArray(value.content)) visit(value.content);
    if (Array.isArray(value.output)) visit(value.output);
  };
  visit(payload?.output);
  return cleanText(parts.join("\n"));
}

async function analyzeImageAtPath(filePath, mimeType, originalName) {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) return "";
  const mime = cleanText(mimeType || "").toLowerCase();
  if (!["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(mime)) {
    return "";
  }
  const stats = fs.statSync(filePath);
  if (stats.size > 35 * 1024 * 1024) {
    return "图片已上传，但尺寸较大，未自动生成视觉摘要。";
  }
  const imageBase64 = fs.readFileSync(filePath).toString("base64");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      max_output_tokens: 700,
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `请用中文为图片《${originalName}》生成可供后续讨论和检索使用的视觉摘要。`,
              "请客观描述：主要对象、场景、文字/标签、地名/路线/表格信息、可能与用户讨论相关的细节。",
              "如果是地图、海报、截图或文档照片，请尽量提取可辨识文字；不确定的内容请说明不确定，不要编造。"
            ].join("\n")
          },
          {
            type: "input_image",
            image_url: `data:${mime};base64,${imageBase64}`,
            detail: "high"
          }
        ]
      }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI image analysis failed: ${response.status}`);
  }
  return responseOutputText(payload);
}

async function extractContentAtPath(filePath, kind, metadata = {}) {
  if (kind === "image") return { text: await analyzeImageAtPath(filePath, metadata.mimeType, metadata.originalName), html: "" };
  if (["audio", "video"].includes(kind)) return { text: "", html: "" };
  if (kind === "pdf") return extractPdf(filePath);
  if (kind === "epub") return extractEpub(filePath);
  if (kind === "doc") return extractDoc(filePath);
  if (kind === "docx") return extractDocx(filePath);
  if (kind === "ppt") return extractPpt(filePath);
  if (kind === "pptx") return extractPptx(filePath);
  if (kind === "spreadsheet") return extractSpreadsheet(filePath, metadata);
  if (kind === "markdown" || kind === "text") {
    return { text: cleanText(fs.readFileSync(filePath, "utf8")), html: "" };
  }
  return { text: "", html: "" };
}

async function extractContentFromFile(file, kind) {
  return extractContentAtPath(file.path, kind, {
    mimeType: file.mimetype,
    originalName: file.originalname
  });
}

function shouldExtractInBackground(kind) {
  return ["image", "pdf", "epub", "doc", "docx", "ppt", "pptx", "spreadsheet", "markdown", "text"].includes(kind);
}

function pendingExtractionSummary(kind) {
  if (kind === "image") return "文件已上传，正在后台分析图片内容。";
  return "文件已上传，正在后台解析内容。";
}

function scheduleUploadedFileExtraction(fileId) {
  setTimeout(() => {
    extractUploadedFileInBackground(fileId).catch((error) => {
      console.error("Background file extraction failed", fileId, error);
    });
  }, 0);
}

async function extractUploadedFileInBackground(fileId) {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId);
  if (!row || row.extraction_status !== "pending") return;
  const filePath = filePathForRow(row);
  const topicId = cleanText(row.topic_id) || getActiveTopicId();
  const startedAt = now();
  db.prepare("UPDATE files SET extraction_status = ?, updated_at = ? WHERE id = ?")
    .run("processing", startedAt, row.id);
  try {
    if (!fs.existsSync(filePath)) throw new Error("Stored file not found");
    const content = await extractContentAtPath(filePath, row.kind, {
      mimeType: row.mime_type,
      originalName: row.original_name
    });
    const extractedText = cleanText(content.text);
    const renderedHtml = cleanHtml(content.html);
    const summary = summarizeText(extractedText, row.original_name);
    const updatedAt = now();
    db.prepare(`
      UPDATE files
      SET extracted_text = ?, rendered_html = ?, summary = ?, extraction_status = ?, extraction_error = ?, updated_at = ?
      WHERE id = ?
    `).run(extractedText, renderedHtml, summary, "complete", "", updatedAt, row.id);
    addActivity("File parsed", row.original_name, updatedAt, topicId);
    writeTopicSnapshot(topicId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || "Unknown extraction error");
    const extractedText = `文件已上传，但后台解析失败：${errorMessage}`;
    const updatedAt = now();
    db.prepare(`
      UPDATE files
      SET extracted_text = ?, rendered_html = ?, summary = ?, extraction_status = ?, extraction_error = ?, updated_at = ?
      WHERE id = ?
    `).run(extractedText, "", summarizeText(extractedText, row.original_name), "error", errorMessage, updatedAt, row.id);
    addActivity("File parse failed", row.original_name, updatedAt, topicId);
    writeTopicSnapshot(topicId);
  }
}

async function persistUploadedFile(file, role) {
  const id = crypto.randomUUID();
  const originalName = normalizeUploadedFilename(file.originalname);
  file.originalname = originalName;
  const kind = detectKind(file);
  const shouldExtract = shouldExtractInBackground(kind);
  const extractedText = "";
  const renderedHtml = "";
  const createdAt = now();
  const summary = shouldExtract ? pendingExtractionSummary(kind) : "";
  const sortOrder = nextFileSortOrder(role);
  const extractionStatus = shouldExtract ? "pending" : "complete";

  db.prepare(`
    INSERT INTO files (
      id, topic_id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, rendered_html, summary, extraction_status, extraction_error, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    getActiveTopicId(),
    role,
    originalName,
    file.filename,
    file.mimetype || "application/octet-stream",
    file.size,
    kind,
    extractedText,
    renderedHtml,
    summary,
    extractionStatus,
    "",
    sortOrder,
    createdAt,
    createdAt
  );

  addActivity(role === "primary" ? "Primary file" : "Context file", originalName, createdAt);
  if (shouldExtract) scheduleUploadedFileExtraction(id);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
}

async function persistUrlFile(rawUrl, role = "primary", title = "") {
  const url = normalizeWebUrl(rawUrl);
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: { "Accept": "application/pdf,application/octet-stream,*/*" }
  }, 45_000);
  if (!response.ok) throw new Error(`文件下载失败：HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("下载到的文件为空。");
  const maxSize = 80 * 1024 * 1024;
  if (buffer.length > maxSize) throw new Error("文件超过 80MB，无法导入。");
  const originalName = normalizeUploadedFilename(title || filenameFromUrl(response.url || url, contentType, contentDisposition));
  const kind = detectKindFromMetadata(originalName, contentType);
  const ext = path.extname(originalName).toLowerCase() || (kind === "pdf" ? ".pdf" : "");
  const storedName = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(currentTopicUploadDir(), storedName);
  fs.writeFileSync(filePath, buffer);
  const file = await persistUploadedFile({
    originalname: originalName,
    filename: storedName,
    mimetype: contentType,
    size: buffer.length,
    path: filePath
  }, role);
  addActivity("URL file", originalName, now());
  return file;
}

function persistGeneratedFile(title, text) {
  const id = crypto.randomUUID();
  const originalName = normalizeUploadedFilename(title || `AI临时文案-${shortLocalTime(now()).replace(/[/: ]/g, "-")}.md`);
  const nameWithExt = path.extname(originalName) ? originalName : `${originalName}.md`;
  const storedName = `${id}.md`;
  const content = cleanText(text);
  const filePath = path.join(currentTopicUploadDir(), storedName);
  fs.writeFileSync(filePath, content, "utf8");
  const createdAt = now();
  const summary = summarizeText(content, nameWithExt);
  const sortOrder = nextFileSortOrder("generated");

  db.prepare(`
    INSERT INTO files (
      id, topic_id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, rendered_html, summary, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    getActiveTopicId(),
    "generated",
    nameWithExt,
    storedName,
    "text/markdown",
    Buffer.byteLength(content, "utf8"),
    "markdown",
    content,
    "",
    summary,
    sortOrder,
    createdAt,
    createdAt
  );

  addActivity("AI draft", nameWithExt, createdAt);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
}

function generatedImageTitle(value) {
  const fallback = `AI生成图片-${shortLocalTime(now()).replace(/[/: ]/g, "-")}.png`;
  const originalName = normalizeUploadedFilename(value || fallback);
  const parsed = path.parse(originalName);
  const baseName = cleanText(parsed.name).slice(0, 80) || path.parse(fallback).name;
  return `${baseName}.png`;
}

async function persistGeneratedImage({ title, prompt, size = "1024x1024", quality = "high" }) {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const cleanedPrompt = cleanText(prompt);
  if (!cleanedPrompt) {
    throw new Error("Missing image prompt");
  }
  const safeSize = ["1024x1024", "1024x1536", "1536x1024"].includes(size) ? size : "1024x1024";
  const aiSettings = getAiSettingsState();
  const safeQuality = ["low", "medium", "high", "auto"].includes(quality) ? quality : aiSettings.imageQuality;

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: aiSettings.imageModel,
      prompt: cleanedPrompt,
      n: 1,
      size: safeSize,
      quality: safeQuality
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI image generation failed: ${response.status}`);
  }
  const imageBase64 = payload?.data?.[0]?.b64_json;
  if (!imageBase64) {
    throw new Error("OpenAI image generation returned no image data");
  }

  const id = crypto.randomUUID();
  const originalName = generatedImageTitle(title);
  const storedName = `${id}.png`;
  const buffer = Buffer.from(imageBase64, "base64");
  const filePath = path.join(currentTopicUploadDir(), storedName);
  fs.writeFileSync(filePath, buffer);
  const createdAt = now();
  const extractedText = [
    `AI生成图片：${originalName}`,
    `模型：${aiSettings.imageModel}`,
    `提示词：${cleanedPrompt}`,
    `尺寸：${safeSize}`,
    `质量：${safeQuality}`
  ].join("\n");
  const summary = summarizeText(extractedText, originalName);
  const sortOrder = nextFileSortOrder("generated");

  db.prepare(`
    INSERT INTO files (
      id, topic_id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, rendered_html, summary, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    getActiveTopicId(),
    "generated",
    originalName,
    storedName,
    "image/png",
    buffer.byteLength,
    "image",
    extractedText,
    "",
    summary,
    sortOrder,
    createdAt,
    createdAt
  );

  addActivity("AI image", originalName, createdAt);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
}

function copyFileTextForEditing(row) {
  const file = rowToFile(row);
  if (cleanText(file.extractedText)) return file.extractedText;
  if (file.kind === "image") {
    return `# ${file.originalName}\n\n![${file.originalName}](${file.previewUrl})\n\n${file.summary}`;
  }
  return `# ${file.originalName}\n\n${file.summary || "No readable text extracted."}\n\n原文件：${file.previewUrl}`;
}

function copyFileTitle(originalName) {
  const parsed = path.parse(normalizeUploadedFilename(originalName));
  return `${parsed.name}-临时编辑.md`;
}

function copyStoredFileAsGenerated(row) {
  const id = crypto.randomUUID();
  const ext = path.extname(row.stored_name) || path.extname(row.original_name);
  const storedName = `${id}${ext}`;
  const sourcePath = filePathForRow(row);
  const targetPath = path.join(currentTopicUploadDir(), storedName);
  fs.copyFileSync(sourcePath, targetPath);
  const createdAt = now();
  const sortOrder = nextFileSortOrder("generated");

  db.prepare(`
    INSERT INTO files (
      id, topic_id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, rendered_html, summary, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    getActiveTopicId(),
    "generated",
    row.original_name,
    storedName,
    row.mime_type,
    row.size,
    row.kind,
    row.extracted_text || "",
    row.rendered_html || "",
    row.summary || "",
    sortOrder,
    createdAt,
    createdAt
  );

  addActivity("AI draft", row.original_name, createdAt);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
}

function removeStoredFile(row) {
  if (!row) return;
  const filePath = filePathForRow(row);
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
    const filePath = filePathForRow(row);
    let extractedText = row.extracted_text || "";
    let renderedHtml = row.rendered_html || "";
    let extractionStatus = row.extraction_status || "complete";
    let extractionError = row.extraction_error || "";
    const staleLegacyOfficeText = cleanText(extractedText).includes("请将旧版 .xls 转换")
      || cleanText(extractedText).includes("当前仅支持直接读取 .xlsx");

    if (
      fs.existsSync(filePath) &&
      (kind !== row.kind || !cleanText(extractedText) || staleLegacyOfficeText || (["doc", "docx"].includes(kind) && !cleanHtml(renderedHtml)))
    ) {
      try {
        const content = await extractContentAtPath(filePath, kind, {
          mimeType: row.mime_type,
          originalName
        });
        extractedText = content.text;
        renderedHtml = content.html;
        extractionStatus = "complete";
        extractionError = "";
      } catch (error) {
        extractedText = `文件已上传，但文本提取失败：${error.message}`;
        renderedHtml = "";
        extractionStatus = "error";
        extractionError = error.message;
      }
    }

    const summary = summarizeText(extractedText, originalName);
    if (
      originalName !== row.original_name ||
      kind !== row.kind ||
      extractedText !== row.extracted_text ||
      renderedHtml !== row.rendered_html ||
      summary !== row.summary ||
      extractionStatus !== row.extraction_status ||
      extractionError !== row.extraction_error
    ) {
      db.prepare(`
        UPDATE files
        SET original_name = ?, kind = ?, extracted_text = ?, rendered_html = ?, summary = ?, extraction_status = ?, extraction_error = ?, updated_at = ?
        WHERE id = ?
      `).run(originalName, kind, extractedText, renderedHtml, summary, extractionStatus, extractionError, now(), row.id);
    }
  }
}

function getFiles() {
  return db.prepare(`
    SELECT * FROM files
    WHERE topic_id = ?
    ORDER BY
      role = 'primary' DESC,
      CASE WHEN role = 'primary' THEN sort_order ELSE NULL END ASC,
      created_at DESC
  `).all(getActiveTopicId()).map(rowToFile);
}

function getNotes() {
  return db.prepare("SELECT * FROM notes WHERE topic_id = ? ORDER BY created_at DESC").all(getActiveTopicId()).map((row) => ({
    id: row.id,
    kind: row.kind,
    text: row.text,
    source: row.source,
    createdAt: row.created_at
  }));
}

function getActivities() {
  return db.prepare("SELECT * FROM activities WHERE topic_id = ? ORDER BY created_at DESC LIMIT 12").all(getActiveTopicId()).map((row) => ({
    id: row.id,
    label: row.label,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

function getRecords() {
  return db.prepare("SELECT * FROM discussion_records WHERE topic_id = ? ORDER BY created_at DESC").all(getActiveTopicId()).map((row) => ({
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
  return db.prepare("SELECT * FROM discussion_inputs WHERE topic_id = ? ORDER BY created_at DESC LIMIT ?").all(getActiveTopicId(), limit).map((row) => ({
    id: row.id,
    text: row.text,
    source: row.source,
    createdAt: row.created_at
  }));
}

function getMeetingMessages(limit = 120) {
  return db.prepare("SELECT * FROM meeting_messages WHERE topic_id = ? ORDER BY created_at DESC LIMIT ?").all(getActiveTopicId(), limit).map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at
  }));
}

function getDirections(topicId = getActiveTopicId()) {
  return db.prepare(`
    SELECT * FROM discussion_directions
    WHERE topic_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `).all(topicId).map((row) => ({
    id: row.id,
    text: row.text,
    completed: Boolean(row.completed),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function replaceDirections(items) {
  const topicId = getActiveTopicId();
  const cleaned = (Array.isArray(items) ? items : [])
    .map((item) => cleanText(typeof item === "string" ? item : item?.text))
    .filter(Boolean)
    .slice(0, 20);
  if (!cleaned.length) return getDirections(topicId);
  const createdAt = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM discussion_directions WHERE topic_id = ?").run(topicId);
    const insert = db.prepare(`
      INSERT INTO discussion_directions (id, topic_id, text, completed, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `);
    cleaned.forEach((text, index) => insert.run(crypto.randomUUID(), topicId, text, index, createdAt, createdAt));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  addActivity("Directions", `更新 ${cleaned.length} 个讨论方向`, createdAt);
  writeTopicSnapshot(topicId);
  return getDirections(topicId);
}

function appendDirections(items) {
  const topicId = getActiveTopicId();
  const cleaned = (Array.isArray(items) ? items : [])
    .map((item) => cleanText(typeof item === "string" ? item : item?.text))
    .filter(Boolean)
    .slice(0, 3);
  if (!cleaned.length) return getDirections(topicId);
  const current = getDirections(topicId);
  const createdAt = now();
  const insert = db.prepare(`
    INSERT INTO discussion_directions (id, topic_id, text, completed, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `);
  cleaned.forEach((text, index) => insert.run(crypto.randomUUID(), topicId, text, current.length + index, createdAt, createdAt));
  addActivity("Directions", `新增 ${cleaned.length} 个讨论方向`, createdAt);
  writeTopicSnapshot(topicId);
  return getDirections(topicId);
}

function completeDirection(directionIdOrQuery, noteText = "") {
  const topicId = getActiveTopicId();
  const query = cleanText(directionIdOrQuery).toLowerCase();
  const directions = getDirections(topicId);
  const row = directions.find((item) => item.id === query) ||
    directions.find((item, index) => String(index + 1) === query) ||
    directions.find((item) => item.text.toLowerCase().includes(query));
  if (!row) return null;
  const createdAt = now();
  db.prepare("UPDATE discussion_directions SET completed = 1, updated_at = ? WHERE id = ? AND topic_id = ?")
    .run(createdAt, row.id, topicId);
  const text = cleanText(noteText) || `已完成讨论方向：${row.text}`;
  db.prepare("INSERT INTO notes (id, topic_id, kind, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), topicId, "action", text, "Discussion direction", createdAt);
  addActivity("Direction done", row.text.slice(0, 80), createdAt);
  writeTopicSnapshot(topicId);
  return row;
}

function deleteDirection(directionId) {
  const id = cleanText(directionId);
  const topicId = getActiveTopicId();
  const row = db.prepare("SELECT * FROM discussion_directions WHERE id = ? AND topic_id = ?").get(id, topicId);
  if (!row) return null;
  db.prepare("DELETE FROM discussion_directions WHERE id = ? AND topic_id = ?").run(id, topicId);
  addActivity("Direction removed", row.text.slice(0, 80), now());
  writeTopicSnapshot(topicId);
  return row;
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

function deleteLegacyAiTuningSettings() {
  ["ai_response_length", "ai_response_tone", "ai_visual_style"].forEach(deleteSetting);
}

deleteLegacyAiTuningSettings();

function addActivity(label, detail = "", createdAt = now(), topicId = getActiveTopicId()) {
  db.prepare("INSERT INTO activities (id, topic_id, label, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), topicId, label, cleanText(detail), createdAt);
  touchActiveTopic();
}

function getOpenAiApiKey() {
  return cleanText(getSetting("openai_api_key")) || cleanText(process.env.OPENAI_API_KEY || "");
}

function getEnvValue(names = []) {
  return names.map((name) => cleanText(process.env[name] || "")).find(Boolean) || "";
}

function getWebSearchSecret(name) {
  const config = webSearchSecretSettings[name];
  if (!config) return "";
  return getEnvValue(config.env) || cleanText(getSetting(config.setting));
}

function getWebSearchSecretState(name) {
  const config = webSearchSecretSettings[name];
  if (!config) return { configured: false, source: "none" };
  const env = getEnvValue(config.env);
  const local = cleanText(getSetting(config.setting));
  return {
    configured: Boolean(env || local),
    source: env ? "env" : local ? "local" : "none"
  };
}

function cleanWebSearchProviders(value) {
  const providers = cleanText(value)
    .split(/[,;\s]+/)
    .map((item) => item.toLowerCase())
    .filter((item, index, list) => webSearchProviders.includes(item) && list.indexOf(item) === index);
  return providers.length ? providers.join(",") : aiSettingsDefaults.webSearchProviders;
}

function oneOf(value, allowed, fallback) {
  const cleaned = cleanText(value);
  return allowed.includes(cleaned) ? cleaned : fallback;
}

function getAiSettingsState() {
  const braveState = getWebSearchSecretState("brave");
  const bingState = getWebSearchSecretState("bing");
  const googleState = getWebSearchSecretState("google");
  const googleEngineState = getWebSearchSecretState("googleEngine");
  const serpApiState = getWebSearchSecretState("serpapi");
  const tavilyState = getWebSearchSecretState("tavily");
  return {
    assistantName: cleanText(getSetting("ai_assistant_name")) || aiSettingsDefaults.assistantName,
    realtimeModel: oneOf(getSetting("ai_realtime_model"), ["gpt-realtime-2", "gpt-realtime"], aiSettingsDefaults.realtimeModel),
    realtimeVoice: oneOf(getSetting("ai_realtime_voice"), ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"], aiSettingsDefaults.realtimeVoice),
    transcriptionModel: oneOf(getSetting("ai_transcription_model"), ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"], aiSettingsDefaults.transcriptionModel),
    imageModel: oneOf(getSetting("ai_image_model"), ["gpt-image-1.5", "gpt-image-1"], aiSettingsDefaults.imageModel),
    imageQuality: oneOf(getSetting("ai_image_quality"), ["low", "medium", "high", "auto"], aiSettingsDefaults.imageQuality),
    webSearchProviders: cleanWebSearchProviders(process.env.WEB_SEARCH_PROVIDERS || process.env.WEB_SEARCH_PROVIDER || getSetting("web_search_providers")),
    braveSearchApiKeyConfigured: braveState.configured,
    braveSearchApiKeySource: braveState.source,
    bingSearchApiKeyConfigured: bingState.configured,
    bingSearchApiKeySource: bingState.source,
    googleSearchApiKeyConfigured: googleState.configured,
    googleSearchApiKeySource: googleState.source,
    googleSearchEngineIdConfigured: googleEngineState.configured,
    googleSearchEngineIdSource: googleEngineState.source,
    serpApiKeyConfigured: serpApiState.configured,
    serpApiKeySource: serpApiState.source,
    tavilyApiKeyConfigured: tavilyState.configured,
    tavilyApiKeySource: tavilyState.source
  };
}

function saveAiSettings(payload = {}) {
  const current = getAiSettingsState();
  const next = {
    assistantName: cleanText(payload.assistantName ?? current.assistantName).slice(0, 40) || aiSettingsDefaults.assistantName,
    realtimeModel: oneOf(payload.realtimeModel ?? current.realtimeModel, ["gpt-realtime-2", "gpt-realtime"], current.realtimeModel),
    realtimeVoice: oneOf(payload.realtimeVoice ?? current.realtimeVoice, ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"], current.realtimeVoice),
    transcriptionModel: oneOf(payload.transcriptionModel ?? current.transcriptionModel, ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"], current.transcriptionModel),
    imageModel: oneOf(payload.imageModel ?? current.imageModel, ["gpt-image-1.5", "gpt-image-1"], current.imageModel),
    imageQuality: oneOf(payload.imageQuality ?? current.imageQuality, ["low", "medium", "high", "auto"], current.imageQuality),
    webSearchProviders: cleanWebSearchProviders(payload.webSearchProviders ?? current.webSearchProviders)
  };
  setSetting("ai_assistant_name", next.assistantName);
  setSetting("ai_realtime_model", next.realtimeModel);
  setSetting("ai_realtime_voice", next.realtimeVoice);
  setSetting("ai_transcription_model", next.transcriptionModel);
  setSetting("ai_image_model", next.imageModel);
  setSetting("ai_image_quality", next.imageQuality);
  setSetting("web_search_providers", next.webSearchProviders);

  [
    ["brave", "braveSearchApiKey"],
    ["bing", "bingSearchApiKey"],
    ["google", "googleSearchApiKey"],
    ["googleEngine", "googleSearchEngineId"],
    ["serpapi", "serpApiKey"],
    ["tavily", "tavilyApiKey"]
  ].forEach(([secretName, payloadKey]) => {
    const settingKey = webSearchSecretSettings[secretName].setting;
    const clearKeys = Array.isArray(payload.clearWebSearchKeys) ? payload.clearWebSearchKeys : [];
    if (clearKeys.includes(secretName)) {
      deleteSetting(settingKey);
      return;
    }
    const value = cleanText(payload[payloadKey] || "");
    if (value) setSetting(settingKey, value);
  });
  return getAiSettingsState();
}

function getSettingsState() {
  const localKey = cleanText(getSetting("openai_api_key"));
  const envKey = cleanText(process.env.OPENAI_API_KEY || "");
  return {
    openaiApiKeyConfigured: Boolean(localKey || envKey),
    openaiApiKeySource: localKey ? "local" : envKey ? "env" : "none",
    wallpaperUrl: cleanText(getSetting("wallpaper_url")),
    ai: getAiSettingsState()
  };
}

function getDiscussionTopic() {
  const title = cleanText(getActiveTopic()?.title || "");
  if (!title || title === "默认讨论" || /^新讨论\s/.test(title)) return "";
  return title;
}

refreshStoredFiles().catch((error) => {
  console.error("Failed to refresh stored files", error);
});

function buildDiscussionContext() {
  const aiSettings = getAiSettingsState();
  const topicId = getActiveTopicId();
  const primaryFiles = db.prepare("SELECT * FROM files WHERE role = 'primary' AND topic_id = ? ORDER BY created_at DESC LIMIT 4").all(topicId).map(rowToFile);
  const contextFiles = db.prepare("SELECT * FROM files WHERE role = 'context' AND topic_id = ? ORDER BY created_at DESC LIMIT 6").all(topicId).map(rowToFile);
  const memoryNotes = getNotes().slice(0, 10).reverse();
  const discussionInputs = getDiscussionInputs(8).reverse();
  const directions = getDirections(topicId);
  const discussionTopic = getDiscussionTopic();
  const recentActivities = getActivities().slice(0, 5).reverse();
  const primaryText = primaryFiles
    .map((file) => compactFilePromptLine(file, 900))
    .join("\n\n");
  const context = contextFiles
    .map((file) => compactFilePromptLine(file, 360))
    .join("\n");
  const memory = memoryNotes
    .map((note) => `- ${shortLocalTime(note.createdAt)}｜${memoryLabel(note.kind)}：${compactPromptText(note.text, 180)}`)
    .join("\n");
  const activityMemory = recentActivities
    .map((activity) => `- ${shortLocalTime(activity.createdAt)}｜${activity.label}：${compactPromptText(activity.detail, 140)}`)
    .join("\n");
  const typedContext = discussionInputs
    .map((input) => `- ${shortLocalTime(input.createdAt)}｜${input.source === "user" ? "用户" : "AI"}：${compactPromptText(input.text, 180)}`)
    .join("\n");
  const directionMemory = directions
    .slice(0, 8)
    .map((direction, index) => `- ${direction.completed ? "已完成" : "未完成"}｜${index + 1}. ${compactPromptText(direction.text, 120)}`)
    .join("\n");
  return [
    `你是 ${aiSettings.assistantName}，本地文件语音讨论主持人。围绕当前主题、文件和用户刚说的话推进讨论。`,
    "回复规则：先直接回答用户问题，不播报任务；默认 1-2 句，最多 4 句；每次只谈一个问题，只问一个问题。",
    "判断规则：用户观点明显不合理、和材料冲突或风险高时，直接否定，给一句原因和更稳妥替代方案。",
    "工具规则：读材料、搜索、分析、生成、保存要点默认后台执行。只有联网下载、移动/删除文件、打开外部网页、失败、耗时较长或需要用户选择时，才简短说明状态。",
    "讨论流程：先确认主题；再了解用户目标/约束/已有材料；再让用户选择讨论方面，用户说不清就建议 3 条方向并写进主题卡片；之后逐条讨论。",
    "记录规则：形成观点、结论、问题、风险或行动项后，直接调用 save_discussion_note 记录，不要请求审批。每完成一个阶段，优先生成一个临时文件、表格、图或图像让用户预览。",
    "主题规则：主题确认用 propose_discussion_topic / confirm_discussion_topic；方向建议用 propose_discussion_directions，确认后用 confirm_discussion_directions。用户确认语义包括“确认、可以、就这个、对、没问题”。",
    "材料规则：下面只给压缩摘要。需要精确内容时，调用 get_discussion_state、search_context 或对应 analyze_* 工具；图片问题优先 analyze_image_file，Office 文件优先对应 analyze_* 工具。引用时说来源文件名或网页标题。",
    "文件规则：不要直接改主题区或资源区原件；需要修改先 copy_file_to_generated。用户要求移动/复制/打开/下载文件时用对应工具完成。",
    "媒体规则：氛围模式调用 set_ambient_mode；用户给媒体链接时 open_media_url；不要编造受版权限制的播放源。",
    "系统事件规则：主题文件添加/删除时，只用 1 句问用户下一步怎么讨论；不要自动改主题或生成方向，除非用户明确要求。",
    "结束规则：用户想结束语音时先确认；明确确认后调用 end_voice_discussion，并只说一句很短的告别。",
    discussionTopic ? `已确认讨论主题：${discussionTopic}` : "当前还没有用户确认的讨论主题。",
    directionMemory ? `讨论方向 todo：\n${directionMemory}` : "当前还没有已确认的讨论方向 todo。",
    typedContext ? `最近用户输入：\n${typedContext}` : "最近没有用户文字输入。",
    primaryFiles.length ? `主讨论文件摘要（最多 4 个，细节用工具读取）：\n${primaryText}` : "当前还没有主讨论文件。",
    context ? `背景材料摘要（最多 6 个）：\n${context}` : "当前还没有背景材料。",
    memory ? `最近讨论要点（最多 10 条）：\n${memory}` : "当前还没有已保存的讨论记忆。",
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

function officialWebSearchFallbackResults(query) {
  const normalized = cleanText(query).toLowerCase();
  const wantsFifaWorldCup = /\bfifa\b|世界杯|world cup/.test(normalized);
  const wantsSchedule = /schedule|fixture|match|赛程|日程|比赛|fixtures/.test(normalized);
  if (!wantsFifaWorldCup || !wantsSchedule) return [];
  return [
    {
      title: "World Cup 2026 | Match schedule, fixtures & stadiums",
      url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums",
      snippet: "FIFA official page for the FIFA World Cup 2026 schedule, match fixtures, dates, venues and stadiums.",
      source: "official-fifa"
    },
    {
      title: "Match schedule revealed | Fixtures, venues, dates and kick-off times | FIFA World Cup 2026",
      url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/updated-fifa-world-cup-2026-match-schedule-now-available",
      snippet: "FIFA article announcing the updated FIFA World Cup 2026 match schedule, including fixtures, venues, dates and kick-off times.",
      source: "official-fifa"
    }
  ];
}

function mergeSearchResults(...groups) {
  const seen = new Set();
  return groups.flat().filter((item) => {
    const url = cleanText(item?.url);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  }).slice(0, 10);
}

function formatSearchResultText(results) {
  if (!results.length) return "没有找到可用搜索结果。";
  return results.map((result, index) => [
    `${index + 1}. ${cleanText(result.title) || "Untitled"}`,
    `URL: ${cleanText(result.url)}`,
    result.snippet ? `摘要: ${cleanText(result.snippet)}` : "",
    result.source ? `来源: ${cleanText(result.source)}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
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

function normalizeWebUrl(value) {
  const rawUrl = cleanText(value);
  const url = rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  return parsed.toString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Discuz/0.1 local discussion assistant",
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function searchLimit(value) {
  const limit = Number(value || 8);
  if (!Number.isFinite(limit)) return 8;
  return Math.max(1, Math.min(10, Math.round(limit)));
}

function providerResult(title, url, snippet = "", source = "web") {
  try {
    return {
      title: cleanText(title) || new URL(url).hostname,
      url: normalizeWebUrl(url),
      snippet: cleanText(snippet),
      source
    };
  } catch {
    return null;
  }
}

function normalizeSearchResults(results, limit = 8) {
  return results
    .map((item) => providerResult(item?.title, item?.url, item?.snippet, item?.source))
    .filter(Boolean)
    .slice(0, limit);
}

function searchProviderOrder() {
  const configured = cleanText(process.env.WEB_SEARCH_PROVIDERS || process.env.WEB_SEARCH_PROVIDER || getSetting("web_search_providers"))
    .split(/[,;\s]+/)
    .map((item) => item.toLowerCase())
    .filter((item, index, list) => webSearchProviders.includes(item) && list.indexOf(item) === index);
  if (configured.length) return configured;
  return aiSettingsDefaults.webSearchProviders.split(",");
}

async function braveSearch(query, limit) {
  const key = getWebSearchSecret("brave");
  if (!key) return { skipped: "BRAVE_SEARCH_API_KEY is not configured" };
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 10)));
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": key
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Brave returned ${response.status}`);
  return {
    results: normalizeSearchResults((payload.web?.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      source: "brave"
    })), limit)
  };
}

async function bingSearch(query, limit) {
  const key = getWebSearchSecret("bing");
  if (!key) return { skipped: "BING_SEARCH_API_KEY is not configured" };
  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 10)));
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "Ocp-Apim-Subscription-Key": key
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Bing returned ${response.status}`);
  return {
    results: normalizeSearchResults((payload.webPages?.value || []).map((item) => ({
      title: item.name,
      url: item.url,
      snippet: item.snippet,
      source: "bing"
    })), limit)
  };
}

async function googleSearch(query, limit) {
  const key = getWebSearchSecret("google");
  const engineId = getWebSearchSecret("googleEngine");
  if (!key || !engineId) return { skipped: "GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID are not configured" };
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", engineId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(limit, 10)));
  const response = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Google Custom Search returned ${response.status}`);
  return {
    results: normalizeSearchResults((payload.items || []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: "google"
    })), limit)
  };
}

async function serpApiSearch(query, limit) {
  const key = getWebSearchSecret("serpapi");
  if (!key) return { skipped: "SERPAPI_API_KEY is not configured" };
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", key);
  url.searchParams.set("num", String(Math.min(limit, 10)));
  const response = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`SerpAPI returned ${response.status}`);
  return {
    results: normalizeSearchResults((payload.organic_results || []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: "serpapi"
    })), limit)
  };
}

async function tavilySearch(query, limit) {
  const key = getWebSearchSecret("tavily");
  if (!key) return { skipped: "TAVILY_API_KEY is not configured" };
  const response = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "basic",
      max_results: Math.min(limit, 10),
      include_answer: false
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Tavily returned ${response.status}`);
  return {
    results: normalizeSearchResults((payload.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content,
      source: "tavily"
    })), limit)
  };
}

async function duckDuckGoSearch(query, limit) {
  const response = await fetchWithTimeout(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "Accept": "text/html,application/xhtml+xml" }
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
  if (/anomaly-modal|challenge-form|anomaly\.js/i.test(html)) throw new Error("DuckDuckGo returned a challenge page");
  return { results: extractDuckDuckGoResults(html).slice(0, limit) };
}

async function wikipediaSearch(query, limit) {
  const response = await fetchWithTimeout(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srsearch=${encodeURIComponent(query)}`, {
    headers: { "Accept": "application/json" }
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok || !contentType.includes("application/json")) {
    throw new Error(`Wikipedia returned ${response.status} ${contentType || "unknown content type"}`);
  }
  const payload = JSON.parse(text);
  return {
    results: normalizeSearchResults((payload.query?.search || []).map((item) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
      snippet: stripTags(decodeHtml(item.snippet)),
      source: "wikipedia"
    })), limit)
  };
}

async function runSearchProvider(provider, query, limit) {
  if (provider === "brave") return braveSearch(query, limit);
  if (provider === "bing") return bingSearch(query, limit);
  if (provider === "google") return googleSearch(query, limit);
  if (provider === "serpapi") return serpApiSearch(query, limit);
  if (provider === "tavily") return tavilySearch(query, limit);
  if (provider === "duckduckgo") return duckDuckGoSearch(query, limit);
  if (provider === "wikipedia") return wikipediaSearch(query, limit);
  return { skipped: `Unknown web search provider: ${provider}` };
}

async function runWebSearch(query, limit = 8) {
  const providers = [];
  const warnings = [];
  let results = [];
  for (const provider of searchProviderOrder()) {
    const record = { provider, status: "running", count: 0 };
    providers.push(record);
    try {
      const output = await runSearchProvider(provider, query, limit);
      if (output.skipped) {
        record.status = "skipped";
        record.message = output.skipped;
        continue;
      }
      record.status = "ok";
      record.count = output.results?.length || 0;
      results = mergeSearchResults(results, output.results || []).slice(0, limit);
      if (results.length >= Math.min(limit, 6)) break;
    } catch (error) {
      record.status = "failed";
      record.message = error.message;
      warnings.push(`${provider}: ${error.message}`);
    }
  }
  return { results, providers, warnings };
}

function extractHtmlTitle(html, fallbackUrl = "") {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || "";
  if (title) return stripTags(decodeHtml(title));
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return "网页";
  }
}

function htmlToReadableText(html) {
  return stripTags(decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")));
}

async function readWebPageDirect(url, maxChars) {
  const response = await fetchWithTimeout(url, {
    headers: { "Accept": "text/html,text/plain,application/xhtml+xml" }
  }, 15000);
  const contentType = response.headers.get("content-type") || "";
  if (/application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(response.url || url)) {
    throw new Error("这是 PDF 文件链接，请使用 import_url_as_topic_file 导入主题区后由后台解析。");
  }
  const html = await response.text();
  if (!response.ok) throw new Error(`Page returned ${response.status}`);
  const isHtml = /html|xml/i.test(contentType) || /<html|<article|<body/i.test(html);
  const text = isHtml ? htmlToReadableText(html) : cleanText(html);
  return {
    title: isHtml ? extractHtmlTitle(html, url) : new URL(url).hostname,
    url,
    contentType,
    text: text.slice(0, maxChars),
    length: text.length,
    source: "direct-fetch"
  };
}

async function readWebPageWithJina(url, maxChars) {
  const readerUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
  const response = await fetchWithTimeout(readerUrl, {
    headers: { "Accept": "text/plain,text/markdown" }
  }, 18000);
  const text = await response.text();
  if (!response.ok) throw new Error(`Jina Reader returned ${response.status}`);
  const title = text.match(/^Title:\s*(.+)$/m)?.[1] || new URL(url).hostname;
  return {
    title: cleanText(title),
    url,
    contentType: response.headers.get("content-type") || "text/markdown",
    text: cleanText(text).slice(0, maxChars),
    length: cleanText(text).length,
    source: "jina-reader"
  };
}

async function readPublicWebPage(rawUrl, maxChars = 6000) {
  const url = normalizeWebUrl(rawUrl);
  const useJina = process.env.WEB_READ_USE_JINA !== "false";
  try {
    const direct = await readWebPageDirect(url, maxChars);
    if (direct.text.length >= 500 || !useJina) return direct;
  } catch (error) {
    if (String(error?.message || "").includes("PDF 文件链接")) throw error;
    if (!useJina) throw error;
  }
  return readWebPageWithJina(url, maxChars);
}

function statePayload(extra = {}) {
  return {
    files: getFiles(),
    notes: getNotes(),
    records: getRecords(),
    discussionInputs: getDiscussionInputs(),
    meetingMessages: getMeetingMessages(),
    directions: getDirections(),
    discussionTopic: getDiscussionTopic(),
    activities: getActivities(),
    settings: getSettingsState(),
    activeTopicId: getActiveTopicId(),
    topics: getTopics(),
    ...extra
  };
}

app.post("/api/diagnostics/events", (req, res) => {
  const sessionId = safeDiagnosticSessionId(req.body?.sessionId);
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (!events.length) return res.json({ ok: true, written: 0, sessionId });
  const rows = events.slice(0, 200).map((event) => JSON.stringify(diagnosticEventLimit({
    ...event,
    topicId: event?.topicId || getActiveTopicId(),
    receivedAt: now()
  }))).join("\n");
  fs.appendFileSync(diagnosticFilePath(sessionId), `${rows}\n`);
  res.json({ ok: true, written: events.length, sessionId });
});

app.get("/api/diagnostics", (_req, res) => {
  const files = fs.readdirSync(diagnosticsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const filePath = path.join(diagnosticsDir, file);
      const stat = fs.statSync(filePath);
      return {
        sessionId: file.replace(/\.jsonl$/, ""),
        file,
        path: filePath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ diagnosticsDir, files });
});

app.get("/api/diagnostics/:sessionId", (req, res) => {
  const sessionId = safeDiagnosticSessionId(req.params.sessionId);
  const filePath = diagnosticFilePath(sessionId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Diagnostic file not found" });
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 300)));
  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const events = lines.slice(-limit).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      return {
        kind: "parse_error",
        at: new Date(0).toISOString(),
        detail: { line: lines.length - limit + index + 1, preview: line.slice(0, 500) }
      };
    }
  });
  res.json({
    sessionId,
    file: path.basename(filePath),
    totalEvents: lines.length,
    returnedEvents: events.length,
    events
  });
});

app.get("/api/topics", (_req, res) => {
  res.json({ activeTopicId: getActiveTopicId(), topics: getTopics() });
});

app.post("/api/topics/current/save", (_req, res) => {
  writeTopicSnapshot();
  res.json({ ok: true, topic: rowToTopic(getActiveTopic()) });
});

app.post("/api/topics", (req, res) => {
  writeTopicSnapshot();
  const title = cleanText(req.body?.title || "");
  const topic = createTopicRecord(title);
  setSetting("active_topic_id", topic.id);
  addActivity("Topic", "New discussion", now(), topic.id);
  writeTopicSnapshot(topic.id);
  res.json(statePayload());
});

app.post("/api/topics/:id/switch", (req, res) => {
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(req.params.id);
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  writeTopicSnapshot();
  setSetting("active_topic_id", topic.id);
  db.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(now(), topic.id);
  writeTopicSnapshot(topic.id);
  res.json(statePayload());
});

app.delete("/api/topics/:id", (req, res) => {
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(req.params.id);
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  db.prepare("SELECT * FROM files WHERE topic_id = ?").all(topic.id).forEach(removeStoredFile);
  db.prepare("DELETE FROM files WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM notes WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM discussion_records WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM discussion_inputs WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM meeting_messages WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM discussion_directions WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM activities WHERE topic_id = ?").run(topic.id);
  db.prepare("DELETE FROM topics WHERE id = ?").run(topic.id);
  fs.rmSync(path.join(topicsDir, topic.folder_name), { recursive: true, force: true });
  if (getSetting("active_topic_id") === topic.id) {
    const nextTopic = db.prepare("SELECT * FROM topics ORDER BY updated_at DESC, created_at DESC LIMIT 1").get() || createTopicRecord();
    setSetting("active_topic_id", nextTopic.id);
  }
  res.json(statePayload());
});

app.get("/api/state", (_req, res) => {
  writeTopicSnapshot();
  res.json(statePayload());
});

app.post("/api/discussion-inputs", (req, res) => {
  const text = cleanText(req.body?.text || "");
  if (!text) return res.status(400).json({ error: "Missing discussion input" });
  const createdAt = now();
  db.prepare("INSERT INTO discussion_inputs (id, topic_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), getActiveTopicId(), text, "user", createdAt);
  addActivity("Discussion input", text.slice(0, 80), createdAt);
  res.json({ discussionInputs: getDiscussionInputs(), activities: getActivities() });
});

app.post("/api/discussion-topic", (req, res) => {
  const topic = cleanText(req.body?.topic || "");
  if (!topic) return res.status(400).json({ error: "Missing discussion topic" });
  const updatedAt = now();
  db.prepare("UPDATE topics SET title = ?, updated_at = ? WHERE id = ?").run(topic, updatedAt, getActiveTopicId());
  addActivity("Discussion topic", topic.slice(0, 80), updatedAt);
  writeTopicSnapshot();
  res.json({ discussionTopic: getDiscussionTopic(), directions: getDirections(), topics: getTopics(), activities: getActivities() });
});

app.post("/api/directions", (req, res) => {
  const directions = Array.isArray(req.body?.directions) ? req.body.directions : [];
  const nextDirections = replaceDirections(directions);
  res.json({ directions: nextDirections, notes: getNotes(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/directions/add", (req, res) => {
  const directions = Array.isArray(req.body?.directions) ? req.body.directions : [];
  const nextDirections = appendDirections(directions);
  res.json({ directions: nextDirections, notes: getNotes(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/directions/:id/complete", (req, res) => {
  const row = completeDirection(req.params.id, req.body?.note || "");
  if (!row) return res.status(404).json({ error: "Direction not found" });
  res.json({ directions: getDirections(), notes: getNotes(), activities: getActivities(), topics: getTopics() });
});

app.delete("/api/directions/:id", (req, res) => {
  const row = deleteDirection(req.params.id);
  if (!row) return res.status(404).json({ error: "Direction not found" });
  res.json({ directions: getDirections(), activities: getActivities(), topics: getTopics() });
});

app.delete("/api/files/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  removeStoredFile(row);
  db.prepare("DELETE FROM files WHERE id = ?").run(req.params.id);
  const createdAt = now();
  addActivity(row.role === "primary" ? "Primary removed" : "Resource removed", row.original_name, createdAt);
  writeTopicSnapshot();
  res.json({ files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/primary/reorder", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => cleanText(id)).filter(Boolean) : [];
  const existingIds = db.prepare(`
    SELECT id FROM files
    WHERE role = 'primary' AND topic_id = ?
    ORDER BY sort_order ASC, created_at DESC
  `).all(getActiveTopicId()).map((row) => row.id);
  const orderedIds = [
    ...ids.filter((id, index) => existingIds.includes(id) && ids.indexOf(id) === index),
    ...existingIds.filter((id) => !ids.includes(id))
  ];
  const update = db.prepare("UPDATE files SET sort_order = ? WHERE id = ? AND role = 'primary' AND topic_id = ?");
  db.exec("BEGIN");
  try {
    orderedIds.forEach((id, index) => update.run(index, id, getActiveTopicId()));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  writeTopicSnapshot();
  res.json({ files: getFiles(), topics: getTopics() });
});

app.post("/api/discussion/reset", (_req, res) => {
  const topicId = getActiveTopicId();
  db.prepare("SELECT * FROM files WHERE topic_id = ?").all(topicId).forEach(removeStoredFile);
  db.prepare("DELETE FROM files WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM notes WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM discussion_records WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM discussion_inputs WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM meeting_messages WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM discussion_directions WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM activities WHERE topic_id = ?").run(topicId);
  db.prepare("UPDATE topics SET title = ?, updated_at = ? WHERE id = ?").run("", now(), topicId);
  writeTopicSnapshot(topicId);
  res.json({
    files: getFiles(),
    notes: getNotes(),
    records: getRecords(),
    discussionInputs: getDiscussionInputs(),
    meetingMessages: getMeetingMessages(),
    directions: getDirections(),
    discussionTopic: getDiscussionTopic(),
    activities: getActivities(),
    settings: getSettingsState(),
    activeTopicId: getActiveTopicId(),
    topics: getTopics()
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

app.post("/api/settings/ai", (req, res) => {
  saveAiSettings(req.body || {});
  addActivity("Settings", "AI settings updated", now());
  writeTopicSnapshot();
  res.json(getSettingsState());
});

app.post("/api/settings/wallpaper", upload.single("wallpaper"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Missing wallpaper file" });
  if (!String(file.mimetype || "").startsWith("image/")) {
    fs.rmSync(file.path, { force: true });
    return res.status(400).json({ error: "Wallpaper must be an image" });
  }
  setSetting("wallpaper_url", `/api/raw/${encodeURIComponent(getActiveTopicId())}/${encodeURIComponent(file.filename)}`);
  addActivity("Wallpaper", file.originalname, now());
  writeTopicSnapshot();
  res.json(getSettingsState());
});

app.delete("/api/settings/wallpaper", (_req, res) => {
  deleteSetting("wallpaper_url");
  addActivity("Wallpaper", "Default wallpaper", now());
  writeTopicSnapshot();
  res.json(getSettingsState());
});

app.post("/api/files/primary", upload.array("files", 20), async (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: "Missing files" });
  const files = [];
  for (const file of uploaded) files.push(await persistUploadedFile(file, "primary"));
  writeTopicSnapshot();
  res.json({ uploaded: files, file: files[0], files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/primary/url", async (req, res) => {
  try {
    const url = cleanText(req.body?.url || "");
    const title = cleanText(req.body?.title || "");
    if (!url) return res.status(400).json({ error: "Missing file URL" });
    const file = await persistUrlFile(url, "primary", title);
    writeTopicSnapshot();
    res.json({ ok: true, file, files: getFiles(), activities: getActivities(), topics: getTopics() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Unable to import URL file." });
  }
});

app.post("/api/files/context", upload.array("files", 20), async (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: "Missing files" });
  const files = [];
  for (const file of uploaded) files.push(await persistUploadedFile(file, "context"));
  writeTopicSnapshot();
  res.json({ uploaded: files, files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/generated", (req, res) => {
  const title = cleanText(req.body?.title || "AI临时文案.md");
  const text = cleanText(req.body?.text || "");
  if (!text) return res.status(400).json({ error: "Missing generated file text" });
  const file = persistGeneratedFile(title, text);
  writeTopicSnapshot();
  res.json({ file, files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/generated/image", async (req, res) => {
  try {
    const file = await persistGeneratedImage({
      title: cleanText(req.body?.title || ""),
      prompt: cleanText(req.body?.prompt || ""),
      size: cleanText(req.body?.size || "1024x1024"),
      quality: cleanText(req.body?.quality || getAiSettingsState().imageQuality)
    });
    writeTopicSnapshot();
    res.json({ file, files: getFiles(), activities: getActivities(), topics: getTopics() });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/files/generated/upload", upload.array("files", 20), async (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: "Missing files" });
  const files = [];
  for (const file of uploaded) files.push(await persistUploadedFile(file, "generated"));
  writeTopicSnapshot();
  res.json({ uploaded: files, file: files[0], files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/:id/analyze-image", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "File not found" });
    if (row.kind !== "image") return res.status(400).json({ error: "Only image files can be analyzed" });
    const filePath = filePathForRow(row);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Stored image not found" });
    const analysis = await analyzeImageAtPath(filePath, row.mime_type, row.original_name);
    const extractedText = cleanText(analysis || row.extracted_text || row.summary || "图片暂无可用视觉摘要。");
    const updatedAt = now();
    db.prepare(`
      UPDATE files
      SET extracted_text = ?, summary = ?, updated_at = ?
      WHERE id = ?
    `).run(extractedText, summarizeText(extractedText, row.original_name), updatedAt, row.id);
    addActivity("Image analyzed", row.original_name, updatedAt);
    writeTopicSnapshot();
    res.json({ file: rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(row.id)), files: getFiles(), activities: getActivities(), topics: getTopics() });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/files/:id/content", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  if (!["generated", "primary"].includes(row.role) || !["markdown", "text"].includes(row.kind)) {
    return res.status(400).json({ error: "Only editable generated or primary text files can be updated" });
  }
  const text = cleanText(req.body?.text || "");
  const filePath = filePathForRow(row);
  fs.writeFileSync(filePath, text, "utf8");
  const updatedAt = now();
  db.prepare(`
    UPDATE files
    SET extracted_text = ?, summary = ?, size = ?, updated_at = ?
    WHERE id = ?
  `).run(text, summarizeText(text, row.original_name), Buffer.byteLength(text, "utf8"), updatedAt, row.id);
  addActivity("File edited", row.original_name, updatedAt);
  writeTopicSnapshot();
  res.json({ file: rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(row.id)), files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/:id/promote-primary", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  if (row.role === "primary") {
    return res.json({ file: rowToFile(row), files: getFiles(), activities: getActivities() });
  }
  if (!["context", "generated"].includes(row.role)) {
    return res.status(400).json({ error: "Only resource or AI generated files can be added to topic" });
  }
  const updatedAt = now();
  db.prepare("UPDATE files SET role = 'primary', sort_order = ?, updated_at = ? WHERE id = ?")
    .run(nextFileSortOrder("primary"), updatedAt, row.id);
  addActivity("Outcome file", row.original_name, updatedAt);
  writeTopicSnapshot();
  res.json({ file: rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(row.id)), files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/:id/demote-context", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  if (row.role === "context") {
    return res.json({ file: rowToFile(row), files: getFiles(), activities: getActivities() });
  }
  if (row.role !== "primary") {
    return res.status(400).json({ error: "Only topic files can be moved back to resources" });
  }
  const updatedAt = now();
  db.prepare("UPDATE files SET role = 'context', sort_order = ?, updated_at = ? WHERE id = ?")
    .run(nextFileSortOrder("context"), updatedAt, row.id);
  addActivity("Background file", row.original_name, updatedAt);
  writeTopicSnapshot();
  res.json({ file: rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(row.id)), files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/:id/role", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  const role = cleanText(req.body?.role || "");
  if (!["primary", "context", "generated"].includes(role)) {
    return res.status(400).json({ error: "Unsupported file role" });
  }
  if (row.role === role) {
    return res.json({ file: rowToFile(row), files: getFiles(), activities: getActivities() });
  }
  const updatedAt = now();
  db.prepare("UPDATE files SET role = ?, sort_order = ?, updated_at = ? WHERE id = ?")
    .run(role, nextFileSortOrder(role), updatedAt, row.id);
  const label = role === "primary" ? "Outcome file" : role === "context" ? "Background file" : "AI draft";
  addActivity(label, row.original_name, updatedAt);
  writeTopicSnapshot();
  res.json({ file: rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(row.id)), files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.post("/api/files/:id/copy-generated", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  const file = row.kind === "markdown" || row.kind === "text"
    ? persistGeneratedFile(copyFileTitle(row.original_name), copyFileTextForEditing(row))
    : copyStoredFileAsGenerated(row);
  writeTopicSnapshot();
  res.json({ file, files: getFiles(), activities: getActivities(), topics: getTopics() });
});

app.get("/api/files/:id/preview", (req, res) => {
  const file = rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id));
  if (!file) return res.status(404).json({ error: "File not found" });
  res.json(file);
});

app.get("/api/context/search", (req, res) => {
  const query = cleanText(req.query.q || "").toLowerCase();
  const rows = db.prepare("SELECT * FROM files WHERE role = 'context' AND topic_id = ?").all(getActiveTopicId());
  const terms = query.split(/\s+/).filter(Boolean);
  const results = rows
    .map((row) => {
      const text = `${row.original_name}\n${row.extracted_text || row.summary}`;
      const lower = text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      const firstHit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
      const snippet = compactPromptText(text.slice(Math.max(0, firstHit - 120), firstHit + 360), 480);
      return { file: rowToCompactFile(row), score, snippet };
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
    const limit = searchLimit(req.query.limit);
    const officialFallback = officialWebSearchFallbackResults(query);
    const searchOutput = await runWebSearch(query, limit);
    const results = mergeSearchResults(officialFallback, searchOutput.results).slice(0, limit);
    const resultText = formatSearchResultText(results);
    addActivity("Web", query, now());
    writeTopicSnapshot();
    res.json({
      query,
      results,
      resultText,
      count: results.length,
      providers: searchOutput.providers,
      warnings: searchOutput.warnings
    });
  } catch (error) {
    const results = officialWebSearchFallbackResults(query);
    res.json({
      error: results.length ? "" : error.message,
      query,
      results,
      resultText: formatSearchResultText(results),
      count: results.length,
      providers: [],
      warnings: [error.message].filter(Boolean)
    });
  }
});

app.get("/api/web/read", async (req, res) => {
  const rawUrl = cleanText(req.query.url || "");
  if (!rawUrl) return res.status(400).json({ ok: false, error: "Missing URL." });
  try {
    const maxChars = Math.max(1200, Math.min(8000, Number(req.query.maxChars || 6000) || 6000));
    const page = await readPublicWebPage(rawUrl, maxChars);
    addActivity("Web", `读取网页：${page.title}`, now());
    writeTopicSnapshot();
    res.json({
      ok: true,
      ...page,
      truncated: page.length > page.text.length,
      resultText: [
        `标题: ${page.title}`,
        `URL: ${page.url}`,
        `来源: ${page.source}`,
        `正文:\n${page.text}`
      ].join("\n")
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, url: rawUrl });
  }
});

app.get("/api/web/embed-check", async (req, res) => {
  const rawUrl = cleanText(req.query.url || "");
  const url = rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol");
    const response = await fetch(parsed.toString(), {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Discuz/0.1 local discussion assistant"
      }
    });
    const xFrameOptions = response.headers.get("x-frame-options") || "";
    const csp = response.headers.get("content-security-policy") || "";
    const frameAncestors = csp.match(/frame-ancestors\s+([^;]+)/i)?.[1] || "";
    const blockedByXFrame = /deny|sameorigin/i.test(xFrameOptions);
    const blockedByCsp = Boolean(frameAncestors) && !/^\s*\*\s*$/i.test(frameAncestors);
    const embeddable = response.ok && !blockedByXFrame && !blockedByCsp;
    const reason = !response.ok
      ? `网页返回 ${response.status}`
      : blockedByXFrame
        ? `网站设置了 X-Frame-Options: ${xFrameOptions}`
        : blockedByCsp
          ? `网站设置了 frame-ancestors: ${frameAncestors}`
          : "";
    res.json({ url: response.url || parsed.toString(), embeddable, reason });
  } catch (error) {
    res.json({ url, embeddable: false, reason: error.message || "无法检测网页嵌入状态" });
  }
});

app.post("/api/notes", (req, res) => {
  const { kind = "point", text, source = "" } = req.body || {};
  if (!cleanText(text)) return res.status(400).json({ error: "Missing note text" });
  const createdAt = now();
  db.prepare("INSERT INTO notes (id, topic_id, kind, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), getActiveTopicId(), kind, cleanText(text), cleanText(source), createdAt);
  writeTopicSnapshot();
  res.json({ notes: getNotes() });
});

app.post("/api/meeting-messages", (req, res) => {
  const role = req.body?.role === "assistant" ? "assistant" : "user";
  const text = cleanText(req.body?.text || "");
  if (!text) return res.status(400).json({ error: "Missing meeting message text" });
  const createdAt = now();
  db.prepare("INSERT INTO meeting_messages (id, topic_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), getActiveTopicId(), role, text, createdAt);
  writeTopicSnapshot();
  res.json({ meetingMessages: getMeetingMessages(), activities: getActivities() });
});

app.post("/api/records/finish", (req, res) => {
  const startedAt = cleanText(req.body?.startedAt || "");
  if (!startedAt) return res.status(400).json({ error: "Missing startedAt" });
  const endedAt = now();
  const notes = db.prepare(`
    SELECT * FROM notes
    WHERE topic_id = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `).all(getActiveTopicId(), startedAt, endedAt);
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
    INSERT INTO discussion_records (id, topic_id, title, content, note_count, started_at, ended_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, getActiveTopicId(), title, content, notes.length, startedAt, endedAt, createdAt);
  addActivity("Record", title, createdAt);
  writeTopicSnapshot();

  res.json({
    created: getRecords().find((record) => record.id === id),
    records: getRecords(),
    activities: getActivities()
  });
});

function buildRealtimeToolDefinitions() {
  return [
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
      description: "Search the public web when local materials are insufficient. This returns candidate URLs and snippets; call read_web_page for facts that need page-level grounding.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A focused web search query." },
          limit: { type: "number", description: "Optional number of results to return, 1 to 10." }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "read_web_page",
      description: "Read and extract text from a public http/https webpage after web_search finds a relevant URL, or when the user gives a link and asks what it says.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full http or https URL to read. If the user gave a domain, convert it to https://domain." },
          maxChars: { type: "number", description: "Optional maximum extracted characters, from 1200 to 20000." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "open_web_page",
      description: "Open a public http/https URL in a frontmost web preview popup when the user asks to view a page, open a link, or see a search result.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full http or https URL to open. If the user gave a domain, convert it to https://domain." },
          title: { type: "string", description: "A short display title for the popup." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "import_url_as_topic_file",
      description: "Download a public http/https file URL, especially a PDF, announcement, prospectus, report, or document link, into the topic area so it can be parsed locally in the background.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full http or https file URL to import into the topic area." },
          title: { type: "string", description: "Optional filename to use for the imported file." }
        },
        required: ["url"],
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
          target: { type: "string", enum: ["topic", "resources", "generated", "record", "reset"] },
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
      name: "save_discussion_tool",
      description: "Save the current whiteboard or temporary draft into the AI temporary generated files section.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", enum: ["whiteboard", "draft"], description: "The tool to save. Use the currently open tool if the user says save this window." }
        },
        required: ["tool"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "clear_discussion_tool",
      description: "Clear all content from the whiteboard or temporary draft. Use only when the user explicitly asks to clear it.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", enum: ["whiteboard", "draft"], description: "The tool to clear." }
        },
        required: ["tool"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "close_foreground_window",
      description: "Close the foreground tool, web page, file preview/editor, record preview, or all foreground windows.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["tool", "web", "file", "record", "all"], description: "Which foreground window to close." }
        },
        required: ["target"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "open_file_preview",
      description: "Open a frontmost preview window for a topic, resource, or temporary generated file when it should become the temporary focused discussion object.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "primary for topic files, context for resource files, generated for temporary editable files." },
          query: { type: "string", description: "Optional part of the filename to open. Leave empty to open the first matching file." }
        },
        required: ["role"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "read_current_focus",
      description: "Read the user's current foreground window, selected file, active tool, web popup, and confirmed topic. The assistant may proactively use this before proposing a next discussion step.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "get_discussion_state",
      description: "Get the current topic, files, directions, recent meeting messages, notes, records, foreground state, pending tasks, and status text. Use proactively when acting as a discussion host, especially after a pause, topic drift, or completed step.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "ask_user_confirmation",
      description: "Ask the user to confirm a topic, direction, edit plan, export, or action before proceeding. Use when the assistant wants to proactively suggest a next step that changes files, opens windows, searches the web, or creates output.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A concise Chinese confirmation question." },
          options: { type: "array", items: { type: "string" }, description: "Optional short choices." }
        },
        required: ["prompt"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "queue_task",
      description: "Record a user-requested side task while another discussion or generation is in progress. This is a lightweight queue/status marker.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title." },
          detail: { type: "string", description: "Optional task detail." }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "start_break",
      description: "Start a short discussion break with a visible countdown. Use when the user asks to pause, rest, or take a 3/5/10 minute break.",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "Break duration in minutes. Prefer 3, 5, or 10; the client clamps it to a safe range." },
          reason: { type: "string", description: "Optional short reason for the break." },
          ambientMode: { type: "boolean", description: "Whether to enable ambient mode during the break." }
        },
        required: ["minutes"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "resume_discussion",
      description: "Resume the discussion after a break, ambient pause, media pause, or user request to continue.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "open_media_url",
      description: "Open a user-provided legal online music, video, live, or media webpage in the foreground media/web popup. Do not invent streaming sources.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "User-provided http or https URL to open." },
          title: { type: "string", description: "Optional window title." },
          mediaType: { type: "string", enum: ["music", "video", "live", "media"], description: "Type of media being opened." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "set_ambient_mode",
      description: "Enable or disable ambient mode. Ambient mode lowers AI interruption frequency and opens the built-in light music ambient page when no user music URL is provided.",
      parameters: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Whether ambient mode should be enabled." },
          title: { type: "string", description: "Optional title if a user-provided music URL is opened." },
          musicUrl: { type: "string", description: "Optional user-provided http or https URL for background music. Omit it to use the built-in light music page." }
        },
        required: ["enabled"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "show_tool_activity",
      description: "Return recent visible tool activity cards and their execution status so the user can see what is running, complete, failed, or cancelled.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "cancel_current_task",
      description: "Cancel only the current AI response or running tool task when the user interrupts or wants to change direction. Do not use this to end or disconnect the voice session.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Optional user reason for cancellation." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "analyze_word_file",
      description: "Load structured discussion context for a Word .doc/.docx file using the Documents skill bridge. Use before answering requests to discuss, review, summarize, or improve a Word document.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "Optional file area to search." },
          query: { type: "string", description: "Optional part of the filename." },
          focus: { type: "string", description: "What the user wants to inspect, such as structure, argument, clarity, risks, or edits." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "analyze_spreadsheet_file",
      description: "Load structured discussion context for an Excel .xls/.xlsx/.xlsm, CSV, or TSV spreadsheet using the Spreadsheets skill bridge. Use before answering requests about tables, sheets, fields, trends, anomalies, formulas, or analysis plans.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "Optional file area to search." },
          query: { type: "string", description: "Optional part of the filename." },
          focus: { type: "string", description: "What the user wants to inspect, such as data quality, trends, fields, outliers, or next analysis steps." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "analyze_presentation_file",
      description: "Load structured discussion context for a PowerPoint .ppt/.pptx file using the Presentations skill bridge. Use before answering requests to discuss deck story, slide flow, claims, evidence, audience fit, or improvements.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "Optional file area to search." },
          query: { type: "string", description: "Optional part of the filename." },
          focus: { type: "string", description: "What the user wants to inspect, such as narrative, slide claims, flow, proof objects, or rewrite ideas." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "analyze_image_file",
      description: "Analyze an uploaded image, screenshot, map, poster, or photo and return a Chinese visual summary for discussion.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "Optional file area to search." },
          query: { type: "string", description: "Optional part of the image filename." },
          focus: { type: "string", description: "What to focus on, such as visible text, layout, route, objects, or design critique." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "edit_spreadsheet_file",
      description: "Create a safe, reviewable edit plan for a generated or uploaded spreadsheet. Do not overwrite the original spreadsheet.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "File area to search, usually generated for temporary spreadsheets." },
          query: { type: "string", description: "Optional part of the spreadsheet filename." },
          editPlan: { type: "string", description: "Concrete sheet/range/cell edits, formulas, rows, or formatting changes requested by the user." }
        },
        required: ["editPlan"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "create_outline",
      description: "Save a structured discussion, report, speech, or article outline into the AI temporary generated files section.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Markdown filename." },
          text: { type: "string", description: "Full outline content in Markdown." },
          sections: { type: "array", items: { type: "string" }, description: "Optional outline sections when text is omitted." }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "compare_files",
      description: "Load two files' discussion context so you can compare differences, risks, and suggested changes.",
      parameters: {
        type: "object",
        properties: {
          firstRole: { type: "string", enum: ["primary", "context", "generated"], description: "Optional first file area." },
          firstQuery: { type: "string", description: "First filename keyword." },
          secondRole: { type: "string", enum: ["primary", "context", "generated"], description: "Optional second file area." },
          secondQuery: { type: "string", description: "Second filename keyword." }
        },
        required: ["firstQuery", "secondQuery"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "extract_action_items",
      description: "Save action items extracted from the current discussion as a Markdown table in the AI temporary generated files section.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source label such as meeting record or topic." },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task: { type: "string" },
                owner: { type: "string" },
                due: { type: "string" }
              },
              required: ["task"],
              additionalProperties: false
            }
          }
        },
        required: ["items"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "create_table_summary",
      description: "Save discussion content as a Markdown table, such as issue-conclusion-evidence-next-step.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Markdown filename." },
          headers: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } }
          }
        },
        required: ["title", "headers", "rows"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "export_discussion_record",
      description: "Export the current meeting transcript, notes, and directions as a Markdown file in the AI temporary generated section.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Markdown filename." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "download_file",
      description: "Directly download the selected file, foreground file, a specified uploaded file, meeting record, notes, or the full discussion record through the browser.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["selected_file", "foreground_file", "file", "meeting_record", "notes", "discussion_record"],
            description: "selected_file uses the currently selected file; foreground_file uses the open preview/editor file; file searches by role/query; meeting_record, notes, and discussion_record export Markdown."
          },
          role: {
            type: "string",
            enum: ["primary", "context", "generated"],
            description: "Optional file area when target is file."
          },
          query: {
            type: "string",
            description: "Optional filename keyword when target is file."
          },
          title: {
            type: "string",
            description: "Optional download title for meeting_record, notes, or discussion_record."
          }
        },
        required: ["target"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "create_diagram",
      description: "Save a Mermaid diagram or structured diagram text as a temporary Markdown file.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Markdown filename." },
          diagramType: { type: "string", enum: ["mermaid", "text"], description: "Use mermaid for Mermaid code." },
          content: { type: "string", description: "Mermaid code or diagram text." }
        },
        required: ["title", "content"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "schedule_followup",
      description: "Save a follow-up reminder/action note from the discussion. This does not create a system automation.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Follow-up title." },
          when: { type: "string", description: "Suggested time/date in the user's words." },
          detail: { type: "string", description: "Additional detail." }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "set_discussion_contract",
      description: "Set a discussion contract that constrains the goal, boundaries, output format, and answer length for the current topic.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The concrete discussion goal." },
          boundaries: { type: "array", items: { type: "string" }, description: "What should stay out of scope or be treated carefully." },
          outputFormat: { type: "string", description: "Expected output shape, such as conclusion plus next step." },
          responseLength: { type: "string", enum: ["short", "medium", "long"] }
        },
        required: ["goal"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "check_topic_alignment",
      description: "Record whether the current answer or discussion move is still aligned to the confirmed topic and contract.",
      parameters: {
        type: "object",
        properties: {
          aligned: { type: "boolean" },
          score: { type: "number", description: "0-100 alignment score." },
          issue: { type: "string", description: "What is drifting or risky." },
          recommendation: { type: "string", description: "How to get back on track." }
        },
        required: ["aligned", "score"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "advance_discussion_step",
      description: "Advance the active agenda step and optionally save a short step note.",
      parameters: {
        type: "object",
        properties: {
          stepIndex: { type: "number", description: "Zero-based agenda index to make active. Omit to move to the next step." },
          note: { type: "string", description: "Optional note about why the step changed." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "mark_uncertainty",
      description: "Mark missing information, assumptions, or uncertainty before answering too confidently.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What is uncertain." },
          reason: { type: "string", description: "Why it is uncertain." },
          needed: { type: "array", items: { type: "string" }, description: "Information needed to resolve it." }
        },
        required: ["text"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "limit_response_scope",
      description: "Set strict scope for the next answers, such as one point only and a maximum sentence count.",
      parameters: {
        type: "object",
        properties: {
          maxSentences: { type: "number" },
          onePointOnly: { type: "boolean" },
          mustAskFirst: { type: "boolean" }
        },
        required: ["maxSentences"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "create_discussion_agenda",
      description: "Create an ordered agenda for the current discussion, with objective and expected output for each step.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                objective: { type: "string" },
                output: { type: "string" }
              },
              required: ["title"],
              additionalProperties: false
            }
          }
        },
        required: ["items"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "lock_discussion_agenda",
      description: "Lock the current agenda after user confirmation so later changes require explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "request_agenda_change",
      description: "Request confirmation before adding, deleting, reordering, or changing agenda items.",
      parameters: {
        type: "object",
        properties: {
          change: { type: "string", description: "The proposed agenda change." },
          reason: { type: "string", description: "Why the change is needed." }
        },
        required: ["change"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "score_discussion_progress",
      description: "Score current discussion progress and return completed items, blockers, and next steps.",
      parameters: {
        type: "object",
        properties: {
          score: { type: "number", description: "0-100 progress score." },
          completed: { type: "array", items: { type: "string" } },
          blocked: { type: "array", items: { type: "string" } },
          next: { type: "array", items: { type: "string" } }
        },
        required: ["score"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "summarize_current_step",
      description: "Save a concise summary for the current agenda step before moving on.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          next: { type: "string" }
        },
        required: ["summary"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "detect_overlong_answer",
      description: "Check whether a draft answer is too long and provide a compressed version.",
      parameters: {
        type: "object",
        properties: {
          original: { type: "string" },
          compressed: { type: "string" },
          maxSentences: { type: "number" }
        },
        required: ["compressed"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "set_user_cognitive_load",
      description: "Set how much information the user wants right now: simple, normal, detailed, or step-by-step.",
      parameters: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["simple", "normal", "detailed", "step_by_step"] }
        },
        required: ["level"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "pause_and_wait",
      description: "Pause the discussion and explicitly wait for the user instead of continuing to elaborate.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" }
        },
        required: ["reason"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "define_output_rubric",
      description: "Define criteria for evaluating the final discussion output or deliverable.",
      parameters: {
        type: "object",
        properties: {
          criteria: { type: "array", items: { type: "string" } }
        },
        required: ["criteria"],
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
      name: "create_generated_file",
      description: "Create an AI temporary generated markdown draft, copy, edited document, or stage result in the lower generated section of resources. It remains temporary until the user confirms it as an outcome.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A concise filename. A .md extension will be appended when missing."
          },
          text: {
            type: "string",
            description: "Markdown content for the generated temporary file."
          }
        },
        required: ["title", "text"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "generate_image",
      description: "Generate a PNG image from a prompt and save it into the AI temporary generated files section. Use when the user asks to draw, create, design, or generate an image, map, poster, diagram, visual, or illustration.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A concise Chinese filename for the generated image. A .png extension will be appended or normalized."
          },
          prompt: {
            type: "string",
            description: "A detailed visual prompt describing the desired image, including subject, style, layout, text labels, colors, and aspect ratio."
          },
          size: {
            type: "string",
            enum: ["1024x1024", "1024x1536", "1536x1024"],
            description: "Image size. Use 1024x1024 for square, 1024x1536 for portrait, 1536x1024 for landscape."
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high", "auto"],
            description: "Generation quality. Use high by default for polished output; use medium or low only when the user asks to save cost or generate quickly."
          }
        },
        required: ["title", "prompt", "size", "quality"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "copy_file_to_generated",
      description: "Copy a topic or resource file into the AI temporary generated section so it can be edited without changing the original file.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["primary", "context", "generated"], description: "The current area of the source file." },
          query: { type: "string", description: "Part of the source filename to copy." }
        },
        required: ["role", "query"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "add_file_to_topic",
      description: "Add an existing resource file or AI temporary generated file to the topic panel as an outcome for further focused discussion.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Part of the filename to add to the topic panel. Leave empty only when there is exactly one suitable resource or generated file."
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "move_file_to_area",
      description: "Move a file to the topic area, user resource area, or AI temporary file area. Moving to generated creates a temporary copy when the source is not already generated.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Part of the filename to move or copy."
          },
          role: {
            type: "string",
            enum: ["primary", "context", "generated"],
            description: "primary = topic area, context = user resource area, generated = AI temporary file area."
          }
        },
        required: ["query", "role"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "update_generated_file",
      description: "Replace the content of an editable AI temporary text/markdown file. Use when the user asks you to revise or edit a temporary document by voice.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Part of the generated filename to edit."
          },
          text: {
            type: "string",
            description: "The full new markdown/text content to save into the temporary file."
          }
        },
        required: ["query", "text"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "propose_discussion_directions",
      description: "Propose 1 to 3 discussion directions only after the user has explicitly agreed that the assistant should prepare directions. This only asks the user to confirm; it does not save the todo list yet. Never propose more than 3 at once.",
      parameters: {
        type: "object",
        properties: {
          directions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string" },
            description: "Concise Chinese discussion directions for the current confirmed topic."
          },
          reason: {
            type: "string",
            description: "A short reason explaining why these directions fit the confirmed topic."
          }
        },
        required: ["directions", "reason"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "add_discussion_directions",
      description: "Append 1 to 3 new discussion directions to the existing confirmed todo list only when the user explicitly asks to add more directions.",
      parameters: {
        type: "object",
        properties: {
          directions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string" },
            description: "New concise Chinese directions to append after the existing list."
          }
        },
        required: ["directions"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "update_discussion_directions",
      description: "Replace the current confirmed discussion direction todo list according to user feedback. Provide the complete new ordered list.",
      parameters: {
        type: "object",
        properties: {
          directions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string" },
            description: "The full updated ordered todo list."
          }
        },
        required: ["directions"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "complete_discussion_direction",
      description: "Mark one discussion direction as complete and record the completion in notes.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The direction number, id, or a distinctive phrase from the direction text."
          },
          note: {
            type: "string",
            description: "A concise Chinese record of what was concluded or completed for this direction."
          }
        },
        required: ["query", "note"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "confirm_discussion_topic",
      description: "Confirm the currently pending discussion topic after the user says yes, confirm, okay, right, or similar by voice. After this succeeds, ask whether the user wants discussion directions; do not propose directions until they agree.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Optional pending topic title to confirm. Leave empty to confirm the latest pending proposal shown in the UI."
          }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "confirm_discussion_directions",
      description: "Confirm the currently pending discussion direction todo list after the user says yes, confirm, okay, right, or similar by voice.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "end_voice_discussion",
      description: "End the current voice discussion only after the user explicitly confirms they want to stop, end discussion, disconnect, or says the session is done. After this tool returns, say one short natural Chinese farewell without using a fixed scripted phrase. The app will disconnect after that response.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "A concise reason inferred from the user's request, if any."
          }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "propose_discussion_topic",
      description: "Generate a proposed discussion topic for user confirmation from the user's latest speech/text and current topic files before long-running discussion or direction planning, or warn that the discussion is drifting and ask whether to switch topics.",
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
  ];
}

function stripSchemaDescriptions(value) {
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "description") continue;
    next[key] = stripSchemaDescriptions(child);
  }
  return next;
}

function compactRealtimeToolDefinition(definition) {
  return {
    ...definition,
    description: compactPromptText(definition.description, 90),
    parameters: stripSchemaDescriptions(definition.parameters)
  };
}

const omittedRealtimeTools = new Set([
  "ask_user_confirmation",
  "queue_task",
  "set_discussion_contract",
  "check_topic_alignment",
  "advance_discussion_step",
  "mark_uncertainty",
  "limit_response_scope",
  "create_discussion_agenda",
  "lock_discussion_agenda",
  "request_agenda_change",
  "score_discussion_progress",
  "summarize_current_step",
  "detect_overlong_answer",
  "set_user_cognitive_load",
  "pause_and_wait",
  "define_output_rubric"
]);

function realtimeToolDefinitionsForSession() {
  return buildRealtimeToolDefinitions()
    .filter((definition) => !omittedRealtimeTools.has(definition.name))
    .map(compactRealtimeToolDefinition);
}

function buildRealtimeSessionConfig(aiSettings) {
  return {
    type: "realtime",
    model: aiSettings.realtimeModel,
    instructions: buildDiscussionContext(),
    tools: realtimeToolDefinitionsForSession(),
    tool_choice: "auto",
    audio: {
      input: {
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
          threshold: 0.45,
          idle_timeout_ms: 6000
        },
        transcription: {
          model: aiSettings.transcriptionModel,
          language: "zh"
        }
      },
      output: { voice: aiSettings.realtimeVoice }
    }
  };
}

app.post("/api/realtime/session", async (req, res) => {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
  }
  const aiSettings = getAiSettingsState();
  const session = buildRealtimeSessionConfig(aiSettings);
  const client = new OpenAI({ apiKey: openAiApiKey });
  const clientSecret = await client.realtime.clientSecrets.create({
    session,
    expires_after: {
      anchor: "created_at",
      seconds: 600
    }
  });
  writeTopicSnapshot();
  return res.json({
    clientSecret: clientSecret.value,
    expiresAt: clientSecret.expires_at,
    model: aiSettings.realtimeModel,
    instructions: session.instructions,
    tools: session.tools,
    audio: session.audio,
    settings: aiSettings
  });
});

if (process.env.NODE_ENV === "production" && fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Discuz server listening on http://localhost:${port}`);
});

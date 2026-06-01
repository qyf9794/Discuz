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
const legacyUploadDir = path.join(dataDir, "uploads");
const topicsDir = path.join(dataDir, "topics");
const dbPath = path.join(dataDir, "discuz.sqlite");
const port = Number(process.env.PORT || 8787);

fs.mkdirSync(legacyUploadDir, { recursive: true });
fs.mkdirSync(topicsDir, { recursive: true });

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
app.use("/api/realtime/session", express.text({ type: ["application/sdp", "text/plain"], limit: "2mb" }));
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
  if (mime === "application/msword" || ext === ".doc") return "doc";
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  if ([".xlsx", ".xlsm", ".xls", ".csv", ".tsv"].includes(ext)) return "spreadsheet";
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
  if (ext === ".xlsx" || ext === ".xlsm") return extractXlsx(filePath);
  if (ext === ".csv") return extractDelimitedSpreadsheet(filePath, ",", "CSV 表格");
  if (ext === ".tsv") return extractDelimitedSpreadsheet(filePath, "\t", "TSV 表格");
  return {
    text: "已识别为 Excel 表格，但当前仅支持直接读取 .xlsx、.xlsm、.csv 和 .tsv。请将旧版 .xls 转换为 .xlsx 或 .csv 后重新上传。",
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
  if (kind === "doc") return extractDoc(filePath);
  if (kind === "docx") return extractDocx(filePath);
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
  const sortOrder = nextFileSortOrder(role);

  db.prepare(`
    INSERT INTO files (
      id, topic_id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, rendered_html, summary, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    sortOrder,
    createdAt,
    createdAt
  );

  addActivity(role === "primary" ? "Primary file" : "Context file", originalName, createdAt);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
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

async function persistGeneratedImage({ title, prompt, size = "1024x1024", quality = "medium" }) {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const cleanedPrompt = cleanText(prompt);
  if (!cleanedPrompt) {
    throw new Error("Missing image prompt");
  }
  const safeSize = ["1024x1024", "1024x1536", "1536x1024"].includes(size) ? size : "1024x1024";
  const safeQuality = ["low", "medium", "high", "auto"].includes(quality) ? quality : "medium";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-image-1",
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

    if (
      fs.existsSync(filePath) &&
      (kind !== row.kind || !cleanText(extractedText) || (["doc", "docx"].includes(kind) && !cleanHtml(renderedHtml)))
    ) {
      try {
        const content = await extractContentAtPath(filePath, kind, {
          mimeType: row.mime_type,
          originalName
        });
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
    .slice(0, 8);
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

function addActivity(label, detail = "", createdAt = now(), topicId = getActiveTopicId()) {
  db.prepare("INSERT INTO activities (id, topic_id, label, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), topicId, label, cleanText(detail), createdAt);
  touchActiveTopic();
}

function getOpenAiApiKey() {
  return cleanText(getSetting("openai_api_key")) || cleanText(process.env.OPENAI_API_KEY || "");
}

function getSettingsState() {
  const localKey = cleanText(getSetting("openai_api_key"));
  const envKey = cleanText(process.env.OPENAI_API_KEY || "");
  return {
    openaiApiKeyConfigured: Boolean(localKey || envKey),
    openaiApiKeySource: localKey ? "local" : envKey ? "env" : "none",
    wallpaperUrl: cleanText(getSetting("wallpaper_url"))
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
  const topicId = getActiveTopicId();
  const primaryFiles = db.prepare("SELECT * FROM files WHERE role = 'primary' AND topic_id = ? ORDER BY created_at DESC LIMIT 8").all(topicId).map(rowToFile);
  const contextFiles = db.prepare("SELECT * FROM files WHERE role = 'context' AND topic_id = ? ORDER BY created_at DESC LIMIT 12").all(topicId).map(rowToFile);
  const memoryNotes = getNotes().slice(0, 24).reverse();
  const discussionInputs = getDiscussionInputs(24).reverse();
  const directions = getDirections(topicId);
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
  const directionMemory = directions
    .map((direction, index) => `- ${direction.completed ? "已完成" : "未完成"}｜${index + 1}. ${direction.text}`)
    .join("\n");
  return [
    "你是 Discuz，一个用于本地文件语音讨论的 AI 伙伴。你的对话必须紧密围绕当前主讨论文件、用户给出的背景材料和用户刚刚提出的问题。",
    "语音风格：更活泼、轻松、有一点笑意，像一位反应快、亲切的讨论搭子。不要严肃播报、不要会议主持腔、不要长篇铺陈。",
    "语音节奏：说得自然一点，可以略快但不要赶；用短句，语气有起伏。每次最多 2 句中文，每句尽量不超过 25 个字。需要用户确认时，只问 1 个问题。",
    "表达习惯：可以用“好呀”“可以”“这个点不错”“我先看这块”这类自然口语开头，但不要过度卖萌、不要夸张，不要使用表情符号。",
    "开场规则：语音刚开始或用户还没有明确提出讨论内容时，不要上来就概括主题或调用 propose_discussion_topic。先自然打招呼，例如“嗨，我在”，再问一句“你想先聊哪块？”等用户说明。",
    "默认讨论对象是当前打开的主题文件、前台弹出的预览窗口和白板。除非用户明确要求讨论其他资源文件，或当前信息确实不足，否则不要主动把讨论焦点切到其他文件。",
    "讨论主题不只来自主题文件，也来自用户在底部输入框提交的主题、观点、问题和链接。用户的文字输入优先级很高，要把它当作当前讨论指令的一部分。",
    "主题确认节奏：先和用户轻松聊一句，弄清用户想做什么。只有当用户已经说出具体讨论内容、问题或目标后，且能从用户刚说的话、当前主题文件或图片摘要中概括主题，才调用 propose_discussion_topic 生成拟确认主题给用户确认。用户还没明确说要讨论什么时，只打招呼并询问，不要主动拟主题。主题确认前，不要规划讨论方向、不要生成 todo，也不要进入长期展开。",
    "随着讨论深入，如果你判断已经形成更准确的讨论主题，必须调用 propose_discussion_topic 请用户确认。若你发现用户正在严重偏离已确认主题，也要调用 propose_discussion_topic 提醒用户，并说明是继续原主题还是确认更换主题。",
    "讨论方向 todo 的节奏：主题一旦被用户确认，就立即调用 propose_discussion_directions 提出 3 到 5 个方向等用户确认，不要再等待几轮讨论。语音只轻轻提示“我先列几个方向，你看要不要删改”。用户确认后，界面会在主题区显示 todo。用户不满意时，优先调用 update_discussion_directions 用完整新列表快速替换；用户只想删掉某一条时，可以提醒他点该条右侧删除按钮。每完成一个方向，调用 complete_discussion_direction 标记完成，并写一条简洁记录。",
    "如果收到系统事件提示当前主题文件已被删除，你必须立即停止基于该文件继续分析，并询问用户是停止此主题的讨论，还是更换新的讨论主题/上传新的主题文件。",
    "每次重新打开语音时，你必须先读取下面的讨论记忆，承接此前已经形成的要点、结论、问题和行动项。不要让用户重复已经讨论过的背景；如果记忆和当前文件冲突，以当前文件为准并说明差异。",
    "记录窗口保存的是讨论要点，不是逐句转写。不要把自己或用户的原话逐句写入记录；只有在形成一个完整观点、阶段性结论、待确认问题或行动项后，才调用 save_discussion_note 保存一段简洁总结。每条记录应是一小段话，优先概括“讨论了什么、形成了什么判断、下一步是什么”。",
    "你可以按需调用工具打开白板、临时草稿、媒体窗口，或打开某个主题/资源文件的重点预览窗口辅助讨论。临时窗口用于当次讨论，关闭后视为临时内容；只有用户明确要求保存时，才把内容作为成果或资源延续。",
    "主题区文件是阅读和主要讨论中心；如果需要修改主题文件内容，先调用 copy_file_to_generated，把副本放到 AI 临时生成文案区编辑，不要直接改原主题文件。",
    "如果主题文件或背景材料是 Excel/CSV 表格，你可以基于已提取的工作表、表头和行内容讨论数据结构、异常值、趋势、统计口径、待补充字段和下一步分析。",
    "资源用户区文件只作为阅读和参考上下文，不纳入主要讨论对象，除非用户明确要求打开某个资源文件作为前台临时主题讨论。资源原件不能编辑；需要修改时必须先复制到 AI 临时生成文案区。",
    "AI 临时生成文案区的文件可以编辑、修改、迭代。所有文件都可以通过打开前台预览窗口临时成为当前讨论对象，但这不会改变它们所属区域或最终成果状态。",
    "用户可以用语音要求你操控界面：打开/关闭前台文件窗口、打开无限白板或临时文档、保存或清空白板/临时文档、复制文件到临时区、把文件移动到主题区/资源区/临时区。遇到这些请求时应调用对应工具完成，不只用语言说明。",
    "当你需要生成文案、副本、修改稿或阶段性成果草稿时，先调用 create_generated_file，把它放入资源窗口下半区的 AI 临时生成文案。用户可以先打开编辑并“保存编辑”，这只表示编辑确认；只有用户进一步“确认为成果”后，它才会进入讨论主题窗口，作为最终成果继续讨论。",
    "当用户要求生成、绘制、设计图片、地图、海报、示意图或视觉素材时，调用 generate_image。图片会保存到 AI 临时生成区；生成完成后用一句话提示用户可以预览或确认为成果。",
    "如果用户要求把某个资源文件、AI 临时文案或修改稿作为成果继续讨论，你可以调用 add_file_to_topic，把它加入讨论主题窗口。加入后它就是主讨论文件，应作为后续重点讨论对象。",
    "不要泛泛而谈，不要把话题扩展到无关方向。每次回复优先给出中肯、可执行、能推进讨论的意见。",
    "如果信息不足，先指出缺口，再建议用户补充哪类材料。需要资料时，优先调用本地背景材料检索；本地资料不足时，再调用联网搜索。",
    "引用资料时必须说明来源文件名或网页标题。你的默认任务是提炼关键观点、结论、争议点、风险和下一步，不主动修改原文件。",
    discussionTopic ? `已确认讨论主题：${discussionTopic}` : "当前还没有用户确认的讨论主题。",
    directionMemory ? `讨论方向 todo：\n${directionMemory}` : "当前还没有已确认的讨论方向 todo。",
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
  db.prepare("DELETE FROM discussion_inputs WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM meeting_messages WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM discussion_directions WHERE topic_id = ?").run(topicId);
  db.prepare("DELETE FROM activities WHERE topic_id = ?").run(topicId);
  db.prepare("UPDATE topics SET title = ?, updated_at = ? WHERE id = ?").run(`新讨论 ${shortLocalTime(now())}`, now(), topicId);
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
      quality: cleanText(req.body?.quality || "medium")
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
  addActivity("Web", query, now());
    writeTopicSnapshot();
    res.json({ query, results });
  } catch (error) {
    res.status(502).json({ error: error.message, query, results: [] });
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
        description: "Close the foreground tool, file preview/editor, record preview, or all foreground windows.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["tool", "file", "record", "all"], description: "Which foreground window to close." }
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
              description: "Generation quality. Use medium by default; high only when the user asks for higher quality."
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
        description: "Propose 3 to 5 discussion directions immediately after the user confirms the topic. This only asks the user to confirm; it does not save the todo list yet.",
        parameters: {
          type: "object",
          properties: {
            directions: {
              type: "array",
              minItems: 3,
              maxItems: 5,
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
    ],
    tool_choice: "auto",
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-transcribe",
          language: "zh"
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: true,
          interrupt_response: false
        }
      },
      output: { voice: "shimmer" }
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
  addActivity("Realtime", "Voice session started", now());
  writeTopicSnapshot();
  res.type("application/sdp").send(payload);
});

app.listen(port, () => {
  console.log(`Discuz server listening on http://localhost:${port}`);
});

import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import multer from "multer";
import mammoth from "mammoth";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

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

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
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
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    previewUrl: `/api/raw/${encodeURIComponent(row.stored_name)}`
  };
}

function detectKind(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".txt", ".csv", ".json", ".log", ".xml", ".html", ".css", ".js", ".ts", ".tsx", ".jsx"].includes(ext)) return "text";
  return "unknown";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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
  return cleanText(result.text);
}

async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return cleanText(result.value);
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
  return cleanText(slides.join("\n\n"));
}

async function extractTextFromFile(file, kind) {
  const filePath = path.join(uploadDir, file.filename);
  if (["image", "audio", "video"].includes(kind)) return "";
  if (kind === "pdf") return extractPdf(filePath);
  if (kind === "docx") return extractDocx(filePath);
  if (kind === "pptx") return extractPptx(filePath);
  if (kind === "markdown" || kind === "text") {
    return cleanText(fs.readFileSync(filePath, "utf8"));
  }
  return "";
}

async function persistUploadedFile(file, role) {
  const id = crypto.randomUUID();
  const kind = detectKind(file);
  let extractedText = "";
  try {
    extractedText = await extractTextFromFile(file, kind);
  } catch (error) {
    extractedText = `文件已上传，但文本提取失败：${error.message}`;
  }
  const createdAt = now();
  const summary = summarizeText(extractedText, file.originalname);

  if (role === "primary") {
    db.prepare("UPDATE files SET role = 'context', updated_at = ? WHERE role = 'primary'").run(createdAt);
  }

  db.prepare(`
    INSERT INTO files (
      id, role, original_name, stored_name, mime_type, size, kind,
      extracted_text, summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    role,
    file.originalname,
    file.filename,
    file.mimetype || "application/octet-stream",
    file.size,
    kind,
    extractedText,
    summary,
    createdAt,
    createdAt
  );

  db.prepare("INSERT INTO activities (id, label, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), role === "primary" ? "Primary file" : "Context file", file.originalname, createdAt);

  return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(id));
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

function buildDiscussionContext() {
  const primary = rowToFile(db.prepare("SELECT * FROM files WHERE role = 'primary' ORDER BY created_at DESC LIMIT 1").get());
  const contextFiles = db.prepare("SELECT * FROM files WHERE role = 'context' ORDER BY created_at DESC LIMIT 12").all().map(rowToFile);
  const primaryText = primary?.extractedText ? primary.extractedText.slice(0, 5000) : "";
  const context = contextFiles
    .map((file) => `- ${file.originalName}: ${file.summary}`)
    .join("\n");
  return [
    "你是 Discuz，一个用于本地文件语音讨论的 AI 伙伴。你的对话必须紧密围绕当前主讨论文件、用户给出的背景材料和用户刚刚提出的问题。",
    "不要泛泛而谈，不要把话题扩展到无关方向。每次回复优先给出中肯、可执行、能推进讨论的意见。",
    "如果信息不足，先指出缺口，再建议用户补充哪类材料。需要资料时，优先调用本地背景材料检索；本地资料不足时，再调用联网搜索。",
    "引用资料时必须说明来源文件名或网页标题。你的默认任务是提炼关键观点、结论、争议点、风险和下一步，不主动修改原文件。",
    primary ? `主讨论文件：${primary.originalName}\n${primaryText}` : "当前还没有主讨论文件。",
    context ? `背景材料摘要：\n${context}` : "当前还没有背景材料。"
  ].join("\n\n");
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
    activities: getActivities()
  });
});

app.post("/api/files/primary", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing file" });
  const file = await persistUploadedFile(req.file, "primary");
  res.json({ file, files: getFiles(), activities: getActivities() });
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

app.post("/api/realtime/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
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
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

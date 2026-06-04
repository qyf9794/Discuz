import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const diagnosticsDir = path.join(rootDir, "data", "diagnostics");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Diagnostic file not found: ${filePath}`);
  return fs.readFileSync(filePath, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        return { kind: "parse_error", at: new Date(0).toISOString(), detail: { line: index + 1, preview: line.slice(0, 200) } };
      }
    })
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

function latestDiagnosticFile() {
  if (!fs.existsSync(diagnosticsDir)) return null;
  const files = fs.readdirSync(diagnosticsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const filePath = path.join(diagnosticsDir, file);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.filePath ?? null;
}

function secondsBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 1000;
}

function short(value, max = 90) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function eventText(event) {
  return event?.detail?.text || event?.detail?.transcript || event?.detail?.statusText || event?.detail?.label || "";
}

function analyze(events) {
  const findings = [];
  const openTasks = new Map();
  const openResponses = [];
  const toolFailures = [];
  const realtimeErrors = [];
  const userMessages = [];
  const assistantMessages = [];
  const directionProposals = events.filter((event) => event.kind === "direction_proposal");
  const directionSnapshots = events.filter((event) => event.kind === "directions" && Array.isArray(event.detail?.directions) && event.detail.directions.length > 0);

  for (const event of events) {
    if (event.kind === "task:start") openTasks.set(event.detail?.id, event);
    if (event.kind === "task:finish") openTasks.delete(event.detail?.id);
    if (event.kind === "task:cancel_all") openTasks.clear();
    if (event.kind === "realtime_event" && event.detail?.type === "response.created") openResponses.push(event);
    if (event.kind === "realtime_event" && ["response.done", "response.cancelled", "response.incomplete"].includes(event.detail?.type)) openResponses.pop();
    if (event.kind === "realtime_event" && event.detail?.type === "error") realtimeErrors.push(event);
    if (event.kind === "tool:update" && ["failed", "cancelled"].includes(event.detail?.patch?.status)) toolFailures.push(event);
    if (event.kind === "meeting_message" && event.detail?.role === "user") userMessages.push(event);
    if (event.kind === "meeting_message" && event.detail?.role === "assistant") assistantMessages.push(event);
  }

  for (const userEvent of userMessages) {
    const nextAssistant = assistantMessages.find((event) => event.at > userEvent.at);
    const nextTask = events.find((event) => event.at > userEvent.at && ["task:start", "tool:start", "realtime_event"].includes(event.kind));
    const delay = nextAssistant ? secondsBetween(userEvent.at, nextAssistant.at) : Infinity;
    if (delay > 20 && !nextTask) {
      findings.push({
        severity: "high",
        at: userEvent.at,
        title: "用户发言后超过 20 秒没有 AI 回复，也没有任务事件",
        detail: short(eventText(userEvent))
      });
    } else if (delay > 20) {
      findings.push({
        severity: "medium",
        at: userEvent.at,
        title: `用户发言后 AI 回复延迟 ${Number.isFinite(delay) ? Math.round(delay) : "未知"} 秒`,
        detail: short(eventText(userEvent))
      });
    }
  }

  for (const event of realtimeErrors) {
    findings.push({
      severity: "high",
      at: event.at,
      title: "Realtime 返回错误",
      detail: short(event.detail?.error?.message || JSON.stringify(event.detail?.error || event.detail))
    });
  }

  for (const event of toolFailures) {
    findings.push({
      severity: "medium",
      at: event.at,
      title: `工具失败或取消：${event.detail?.id || ""}`,
      detail: short(event.detail?.patch?.result || JSON.stringify(event.detail?.patch || {}))
    });
  }

  for (const event of openTasks.values()) {
    findings.push({
      severity: "medium",
      at: event.at,
      title: "任务开始后未记录结束",
      detail: short(event.detail?.label || event.detail?.id)
    });
  }

  for (const event of openResponses) {
    findings.push({
      severity: "medium",
      at: event.at,
      title: "response.created 后未看到完成/取消事件",
      detail: short(JSON.stringify(event.detail || {}))
    });
  }

  const pendingDirections = events.filter((event) => event.kind === "directions_after_topic:pending");
  for (const topicEvent of pendingDirections) {
    const nextDirection = directionProposals.find((event) => event.at >= topicEvent.at)
      || directionSnapshots.find((event) => event.at >= topicEvent.at);
    if (!nextDirection && secondsBetween(topicEvent.at, events.at(-1)?.at || topicEvent.at) > 8) {
      findings.push({
        severity: "high",
        at: topicEvent.at,
        title: "主题确认后没有生成待确认讨论方向",
        detail: short(topicEvent.detail?.title)
      });
    }
  }

  return findings.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] || String(a.at).localeCompare(String(b.at));
  });
}

const requestedFile = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : latestDiagnosticFile();
if (!requestedFile) {
  console.log("没有找到诊断日志。先在本地页面操作一轮，再运行 npm run diagnose:conversation。");
  process.exit(0);
}

const events = readJsonl(requestedFile);
const findings = analyze(events);
console.log(`诊断文件：${requestedFile}`);
console.log(`事件数量：${events.length}`);
console.log(`时间范围：${events[0]?.at || "无"} -> ${events.at(-1)?.at || "无"}`);
if (!findings.length) {
  console.log("未发现明显断点。可继续提供具体时间点，我再按时间线人工复盘。");
} else {
  console.log("\n发现的问题：");
  for (const finding of findings.slice(0, 20)) {
    console.log(`- [${finding.severity}] ${finding.at} ${finding.title}${finding.detail ? `：${finding.detail}` : ""}`);
  }
}

import {
  ChartNoAxesColumn,
  ChevronDown,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FilePlus2,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Mic,
  Minus,
  Music,
  PenLine,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { ChangeEvent, DragEvent, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from "react";
import type { AiSettings, AppState, DiscussionDirection, DiscussionRecord, DiscussionTopic, DiscuzFile, MeetingMessage, Note } from "./types";

const emptyState: AppState = {
  files: [],
  notes: [],
  records: [],
  discussionInputs: [],
  meetingMessages: [],
  directions: [],
  backgroundTasks: [],
  discussionTopic: "",
  activeTopicId: "",
  topics: [],
  activities: [],
  settings: {
    openaiApiKeyConfigured: false,
    openaiApiKeySource: "none",
    wallpaperUrl: "",
    ai: {
      assistantName: "Discuz",
      realtimeModel: "gpt-realtime-2",
      realtimeVoice: "shimmer",
      transcriptionModel: "gpt-4o-transcribe",
      imageModel: "gpt-image-1.5",
      imageQuality: "high",
      webSearchProviders: "openai,brave,bing,google,serpapi,tavily,duckduckgo,wikipedia"
    }
  }
};
type TopicProposal = { title: string; reason: string; intent: "confirm" | "drift" };
type DirectionProposal = { directions: string[]; reason: string };
type SettingsState = NonNullable<AppState["settings"]>;
type VoiceState = "idle" | "connecting" | "live" | "thinking" | "error";
type WebPreview = { url: string; title: string; embeddable?: boolean | null; embedReason?: string };
type PanelId = "topic" | "resources" | "generated" | "record";
type ToolId = "whiteboard" | "draft" | "image" | "video" | "audio";
type StatusLogEntry = { id: string; kind: "status" | "error"; text: string; createdAt: string };
type TaskItem = { id: string; label: string; startedAt: string };
type ToolActivity = { id: string; label: string; status: "running" | "done" | "failed" | "cancelled"; startedAt: string; endedAt?: string; detail?: string; result?: string };
type DiagnosticEvent = { type: "task:start" | "task:finish" | "task:cancel"; id: string; label: string; at: string; elapsedMs?: number };
type ConversationDiagnosticEvent = { id: string; at: string; kind: string; topicId?: string; detail?: unknown };
type DiagnosticSnapshot = {
  statusText: string;
  pendingTasks: TaskItem[];
  visibleTasks: TaskItem[];
  toolActivities: ToolActivity[];
  taskEvents: DiagnosticEvent[];
};
type ToolDiagnosticResult = DiagnosticSnapshot & {
  name: string;
  ok: boolean;
  elapsedMs: number;
  result: unknown;
  observedTask: boolean;
};
type RealtimeToolDefinition = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };
type RealtimeTurnDetection = {
  type?: string;
  createResponse?: boolean;
  create_response?: boolean;
  interruptResponse?: boolean;
  interrupt_response?: boolean;
  prefixPaddingMs?: number;
  prefix_padding_ms?: number;
  silenceDurationMs?: number;
  silence_duration_ms?: number;
  threshold?: number;
  idleTimeoutMs?: number;
  idle_timeout_ms?: number;
};
type RealtimeSessionBootstrap = {
  clientSecret: string;
  expiresAt: number;
  model: string;
  instructions: string;
  tools: RealtimeToolDefinition[];
  audio: {
    input?: {
      transcription?: { model?: string; language?: string };
      turnDetection?: RealtimeTurnDetection;
      turn_detection?: RealtimeTurnDetection;
    };
    output?: { voice?: string };
  };
  settings: AiSettings;
};
type PendingVoiceStop = "none" | "awaiting_closing" | "closing_started";
type BoardItem = { id: string; kind: "text" | "image"; value: string; x: number; y: number };
type BoardLink = { id: string; from: string; to: string };
type DiscussionContract = { goal: string; boundaries: string[]; outputFormat: string; responseLength: "short" | "medium" | "long"; updatedAt: string };
type DiscussionAgendaItem = { title: string; objective: string; output: string; status: "pending" | "active" | "done" };
type ResponseScope = { maxSentences: number; onePointOnly: boolean; mustAskFirst: boolean };
type CognitiveLoad = "simple" | "normal" | "detailed" | "step_by_step";
type GlassSelectOption = { value: string; label: string };
const fileDragType = "application/x-discuz-file-id";
type AudioContextConstructor = typeof AudioContext;
type DiscuzDiagnostics = {
  snapshot: () => DiagnosticSnapshot;
  recorder: () => { enabled: boolean; sessionId: string; events: ConversationDiagnosticEvent[] };
  flushRecorder: () => Promise<void>;
  clearEvents: () => void;
  runTool: (_name: string, _args?: Record<string, unknown>) => Promise<ToolDiagnosticResult>;
  runTools: (_items: Array<{ name: string; args?: Record<string, unknown> }>) => Promise<ToolDiagnosticResult[]>;
  runScenario: (_payload: DiagnosticScenarioPayload) => Promise<DiagnosticScenarioResult>;
};
type DiscuzDiagnosticWindow = Window & { __discuzDiagnostics?: DiscuzDiagnostics };
type DiagnosticScenarioPayload = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  tools?: Array<{ name: string; args?: Record<string, unknown> }>;
  parallel?: boolean;
  cancelAfterMs?: number;
};
type DiagnosticScenarioResult = DiagnosticSnapshot & {
  id: string;
  ok: boolean;
  results: ToolDiagnosticResult[];
  error?: string;
};
type VoiceMeter = {
  context: AudioContext;
  inputAnalyser?: AnalyserNode;
  outputAnalyser?: AnalyserNode;
  inputData?: Uint8Array<ArrayBuffer>;
  outputData?: Uint8Array<ArrayBuffer>;
  inputSource?: MediaStreamAudioSourceNode;
  outputSource?: MediaStreamAudioSourceNode;
  frameId: number;
};

function ambientMusicPreview(): WebPreview {
  return { url: "/ambient.html", title: "轻音乐氛围", embeddable: true };
}

function isAmbientPreview(page: WebPreview | null) {
  return page?.url === "/ambient.html";
}

function moveItemByDrop<T extends { id: string }>(items: T[], draggedId: string, targetId: string, after: boolean) {
  const fromIndex = items.findIndex((item) => item.id === draggedId);
  const toIndex = items.findIndex((item) => item.id === targetId);
  if (fromIndex < 0 || toIndex < 0 || draggedId === targetId) return items;
  const next = [...items];
  const [dragged] = next.splice(fromIndex, 1);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  next.splice(after ? targetIndex + 1 : targetIndex, 0, dragged);
  return next;
}

function shouldDropAfter(event: DragEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const midX = rect.left + rect.width / 2;
  const nearSameRow = Math.abs(event.clientY - midY) < rect.height * 0.24;
  return event.clientY > midY || (nearSameRow && event.clientX > midX);
}

function readAnalyserLevel(analyser?: AnalyserNode, data?: Uint8Array<ArrayBuffer>) {
  if (!analyser || !data) return 0;
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / data.length);
  const noiseFloor = 0.008;
  if (rms <= noiseFloor) return 0;
  const normalized = Math.min(1, (rms - noiseFloor) / 0.13);
  return Math.min(1, Math.sqrt(normalized) * 1.12);
}

function realtimeRetryDelayMs(message: string) {
  const match = message.match(/try again in\s+([\d.]+)s/i);
  if (!match) return 800;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return 800;
  return Math.min(15000, Math.max(800, Math.ceil(seconds * 1000) + 450));
}

function voiceStartErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const name = error instanceof DOMException ? error.name : "";
  if (isVoicePermissionError(error)) {
    const site = typeof window !== "undefined" ? window.location.host || "当前站点" : "当前站点";
    return `麦克风权限被拒绝。请在浏览器地址栏或站点设置中允许 ${site} 使用麦克风，并确认系统设置允许当前浏览器使用麦克风，然后刷新页面再试。`;
  }
  if (name === "NotFoundError" || /requested device not found|no.*microphone|not found/i.test(message)) {
    return "没有找到可用麦克风。请连接或启用麦克风后再试。";
  }
  if (name === "NotReadableError" || /could not start|not readable|in use/i.test(message)) {
    return "麦克风暂时不可用，可能被其他应用占用。请关闭占用麦克风的应用后再试。";
  }
  return message || "无法启动语音。";
}

const defaultRealtimeTurnDetection = {
  type: "server_vad",
  createResponse: true,
  interruptResponse: true,
  prefixPaddingMs: 300,
  silenceDurationMs: 650,
  threshold: 0.45,
  idleTimeoutMs: 6000
};

function normalizeRealtimeTurnDetection(value?: RealtimeTurnDetection | null) {
  if (!value) return defaultRealtimeTurnDetection;
  return {
    type: value.type || defaultRealtimeTurnDetection.type,
    createResponse: value.createResponse ?? value.create_response ?? defaultRealtimeTurnDetection.createResponse,
    interruptResponse: value.interruptResponse ?? value.interrupt_response ?? defaultRealtimeTurnDetection.interruptResponse,
    prefixPaddingMs: value.prefixPaddingMs ?? value.prefix_padding_ms ?? defaultRealtimeTurnDetection.prefixPaddingMs,
    silenceDurationMs: value.silenceDurationMs ?? value.silence_duration_ms ?? defaultRealtimeTurnDetection.silenceDurationMs,
    threshold: value.threshold ?? defaultRealtimeTurnDetection.threshold,
    idleTimeoutMs: value.idleTimeoutMs ?? value.idle_timeout_ms ?? defaultRealtimeTurnDetection.idleTimeoutMs
  };
}

function isVoicePermissionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const name = error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError" || /permission denied|notallowed|denied/i.test(message);
}

function loadStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function shortTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function noteLabel(kind: Note["kind"]) {
  return { point: "要点", decision: "结论", question: "问题", action: "行动" }[kind];
}

async function uploadFiles(endpoint: string, field: string, files: File[]) {
  const form = new FormData();
  files.forEach((file) => form.append(field, file));
  const response = await fetch(endpoint, { method: "POST", body: form });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function setCardDragImage(event: DragEvent<HTMLElement>) {
  const source = event.currentTarget;
  const rect = source.getBoundingClientRect();
  const preview = source.querySelector(".topic-card-preview, .thumb-preview")?.cloneNode(true) as HTMLElement | undefined;
  const kind = source.querySelector("footer span")?.textContent?.trim() || "";
  const name = source.querySelector("footer strong")?.textContent?.trim() || "";
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  if (preview) {
    preview.classList.add("drag-ghost-preview");
    ghost.appendChild(preview);
  }
  const footer = document.createElement("footer");
  if (kind) {
    const kindLabel = document.createElement("span");
    kindLabel.textContent = kind;
    footer.appendChild(kindLabel);
  }
  const nameLabel = document.createElement("strong");
  nameLabel.textContent = name || "文件";
  footer.appendChild(nameLabel);
  ghost.appendChild(footer);
  document.body.appendChild(ghost);
  window.getComputedStyle(ghost).opacity;
  event.dataTransfer.setDragImage(ghost, Math.min(36, rect.width / 2), Math.min(28, rect.height / 2));
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => ghost.remove()));
}

function toolCallLabel(name = "任务") {
  return ({
    search_context: "检索本地材料",
    web_search: "联网搜索",
    research_request: "研究路由",
    read_web_page: "读取网页",
    open_web_page: "打开网页",
    import_url_as_topic_file: "导入链接文件",
    analyze_word_file: "分析Word文件",
    analyze_spreadsheet_file: "分析Excel表格",
    analyze_presentation_file: "分析PPT文件",
    analyze_image_file: "分析图片",
    read_current_focus: "读取当前焦点",
    get_discussion_state: "读取讨论状态",
    ask_user_confirmation: "请求用户确认",
    queue_task: "加入任务队列",
    start_break: "开始休息",
    resume_discussion: "继续讨论",
    open_media_url: "打开媒体",
    set_ambient_mode: "设置氛围模式",
    show_tool_activity: "查看工具活动",
    cancel_current_task: "取消当前任务",
    run_background_task: "加入后台任务",
    edit_spreadsheet_file: "编辑表格请求",
    create_outline: "生成大纲",
    compare_files: "比较文件",
    extract_action_items: "提取行动项",
    create_table_summary: "生成表格总结",
    export_discussion_record: "导出讨论记录",
    download_file: "下载文件",
    create_diagram: "生成图表",
    schedule_followup: "安排跟进",
    set_discussion_contract: "设置讨论契约",
    check_topic_alignment: "检查主题对齐",
    advance_discussion_step: "推进讨论步骤",
    mark_uncertainty: "标记不确定性",
    limit_response_scope: "限制回答范围",
    create_discussion_agenda: "生成讨论议程",
    lock_discussion_agenda: "锁定讨论议程",
    request_agenda_change: "请求议程变更",
    score_discussion_progress: "评估讨论进度",
    summarize_current_step: "总结当前步骤",
    detect_overlong_answer: "检查回答过长",
    set_user_cognitive_load: "设置理解负荷",
    pause_and_wait: "暂停等待",
    define_output_rubric: "定义产出标准",
    set_layout: "调整布局",
    open_discussion_tool: "打开工具窗口",
    save_discussion_tool: "保存工具内容",
    clear_discussion_tool: "清空工具内容",
    close_foreground_window: "关闭窗口",
    open_file_preview: "打开文件窗口",
    save_discussion_note: "保存讨论要点",
    create_generated_file: "生成临时文案",
    prepare_discussion_workbench: "准备讨论工作台",
    copy_file_to_generated: "复制到临时区",
    add_file_to_topic: "加入主题区",
    move_file_to_area: "移动文件",
    update_generated_file: "更新临时文案",
    generate_image: "生成图片",
    prepare_discussion_directions: "准备讨论方向",
    propose_discussion_directions: "建议讨论方向",
    update_discussion_directions: "更新讨论方向",
    add_discussion_directions: "追加讨论方向",
    complete_discussion_direction: "完成讨论方向",
    prepare_discussion_topic: "准备讨论主题",
    propose_discussion_topic: "确认讨论主题",
    confirm_discussion_topic: "确认待定主题",
    confirm_discussion_directions: "确认待定方向",
    end_voice_discussion: "结束语音讨论"
  } as Record<string, string>)[name] || name;
}

const backgroundResearchIntentPattern = /全部|完整|所有|全量|整理|生成|保存|导出|打开|预览|主题卡片|主题区|卡片|文件|表格|报告|清单|列表|名单|赛程|日程|赛果|fixture|fixtures|schedule|calendar|timetable|full|all|complete|list|table|report|file|card|open/i;
const artifactResearchPattern = /整理|生成|保存|导出|打开|预览|主题卡片|主题区|卡片|文件|表格|报告|markdown|md|table|report|file|card|open/i;
const deepFileTaskPattern = /全部|完整|全面|详细|深度|逐项|全文|长文|报告|表格|清单|列表|对比|比较|审查|方案|整理|生成|保存|导出|打开|预览|主题卡片|主题区|卡片|文件|full|complete|detailed|deep|report|table|list|compare|review|audit|plan|file|card|open|preview/i;

function shouldUseBackgroundResearch(args: Record<string, any> = {}) {
  const query = String(args.query || args.prompt || "").trim();
  const purpose = String(args.purpose || args.title || "").trim();
  const output = String(args.output || "").trim();
  const combined = `${query}\n${purpose}\n${output}`;
  const expectedItems = Number(args.expectedItems || args.limit || 0);
  if (args.addToTopic === true || args.openWhenDone === true) return true;
  if (["cards", "table", "file", "report"].includes(output)) return true;
  if (expectedItems > 8) return true;
  if (artifactResearchPattern.test(combined)) return true;
  return /全部|完整|所有|全量|full|all|complete/i.test(combined) && backgroundResearchIntentPattern.test(combined);
}

function researchPostActions(args: Record<string, any> = {}) {
  const query = String(args.query || args.prompt || "").trim();
  const purpose = String(args.purpose || args.title || "").trim();
  const combined = `${query}\n${purpose}`;
  const actions: Array<"add_to_topic" | "open_preview"> = [];
  if (args.addToTopic === true || /主题卡片|主题区|卡片|topic card|topic/i.test(combined)) actions.push("add_to_topic");
  if (args.openWhenDone === true || /打开|预览|open|preview/i.test(combined)) actions.push("open_preview");
  if (actions.includes("open_preview") && !actions.includes("add_to_topic") && /主题|卡片|topic|card/i.test(combined)) actions.unshift("add_to_topic");
  return actions.filter((action, index, list) => list.indexOf(action) === index);
}

function shouldQueueFileAnalysis(file: DiscuzFile, focus = "", extra = "") {
  const text = `${focus}\n${extra}`;
  const sourceLength = (file.extractedText || file.summary || "").length;
  if (deepFileTaskPattern.test(text)) return true;
  return sourceLength > 16000;
}

function fileAnalysisPostActions(focus = "") {
  return researchPostActions({ query: focus, purpose: focus });
}

function realtimeEventToolName(...values: unknown[]) {
  const queue = [...values];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const direct = record.name || record.toolName || record.tool_name;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const tool = record.tool;
    if (tool && typeof tool === "object") {
      const toolRecord = tool as Record<string, unknown>;
      const name = toolRecord.name || toolRecord.toolName || toolRecord.tool_name;
      if (typeof name === "string" && name.trim()) return name.trim();
      queue.push(tool);
    }
    ["item", "call", "details", "info"].forEach((key) => {
      const nested = record[key];
      if (nested && typeof nested === "object") queue.push(nested);
    });
  }
  return "";
}

type OfficeAnalysisKind = "word" | "spreadsheet" | "presentation";

function selectOfficeFile(files: DiscuzFile[], kind: OfficeAnalysisKind, role?: DiscuzFile["role"], query = "") {
  const queryText = query.trim().toLowerCase();
  const allowedKinds: Record<OfficeAnalysisKind, DiscuzFile["kind"][]> = {
    word: ["doc", "docx"],
    spreadsheet: ["spreadsheet"],
    presentation: ["ppt", "pptx"]
  };
  const candidates = files.filter((file) => {
    const roleMatches = !role || file.role === role;
    const kindMatches = allowedKinds[kind].includes(file.kind);
    const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
    return roleMatches && kindMatches && nameMatches;
  });
  if (candidates.length) return candidates[0];
  return files.find((file) => {
    const roleMatches = !role || file.role === role;
    return roleMatches && allowedKinds[kind].includes(file.kind);
  }) ?? null;
}

function compactText(value: string, maxChars = 5000) {
  const text = value.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n... 已截断，以上为前 ${maxChars} 字。` : text;
}

function parseHttpUrl(value: string) {
  const rawUrl = value.trim();
  if (!rawUrl) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) && !/^https?:\/\//i.test(rawUrl)) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isLocalPreviewUrl(value: string) {
  return value.startsWith("/");
}

function isDiagnosticsEnabled() {
  if (typeof window === "undefined") return false;
  return import.meta.env.DEV && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function isConversationRecorderEnabled() {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("discuz-conversation-recorder") !== "false";
}

function shrinkDiagnosticDetail(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return compactText(value, depth > 1 ? 800 : 1800);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => shrinkDiagnosticDetail(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).slice(0, 30).forEach(([key, item]) => {
      output[key] = shrinkDiagnosticDetail(item, depth + 1);
    });
    return output;
  }
  return String(value);
}

function isAffirmativeConfirmation(text: string) {
  const normalized = text.replace(/[，。！？、,.!?\s]/g, "").toLowerCase();
  if (!normalized) return false;
  return [
    "确认",
    "可以",
    "好的",
    "好",
    "对",
    "没问题",
    "就这个",
    "就这样",
    "同意",
    "确认一下",
    "我确认",
    "确定"
  ].some((phrase) => normalized === phrase || normalized.includes(phrase));
}

function buildWordAnalysisPayload(file: DiscuzFile, focus: string) {
  const paragraphs = file.extractedText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const possibleHeadings = paragraphs.filter((line) => line.length <= 80 && !/[。！？!?；;]$/.test(line)).slice(0, 8);
  return {
    ok: true,
    mode: "word",
    file: { id: file.id, name: file.originalName, role: file.role, kind: file.kind, summary: file.summary },
    focus,
    structure: {
      paragraphCount: paragraphs.length,
      possibleHeadings,
      openingParagraphs: paragraphs.slice(0, 4)
    },
    instructions: [
      "Use the Documents skill discussion bridge: review structure, argument, clarity, gaps, risks, and possible edits.",
      "Do not claim visual DOCX layout verification unless a separate render-and-review workflow is run."
    ],
    content: compactText(file.extractedText || file.summary || "", 4000)
  };
}

function buildSpreadsheetAnalysisPayload(file: DiscuzFile, focus: string) {
  const sections = (file.extractedText || "")
    .split(/\n\n(?=工作表：|CSV 表格|TSV 表格)/)
    .map((section) => section.trim())
    .filter(Boolean);
  const sheets = sections.map((section) => {
    const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
    const name = lines[0]?.replace(/^工作表：/, "") || file.originalName;
    const dataRows = lines.slice(1).filter((line) => !line.startsWith("... 已截取"));
    return {
      name,
      visibleRowCount: dataRows.length,
      firstRows: dataRows.slice(0, 6),
      truncatedNote: lines.find((line) => line.startsWith("... 已截取")) || ""
    };
  });
  return {
    ok: true,
    mode: "spreadsheet",
    file: { id: file.id, name: file.originalName, role: file.role, kind: file.kind, summary: file.summary },
    focus,
    structure: {
      sheetCount: sheets.length,
      sheets: sheets.slice(0, 6)
    },
    instructions: [
      "Use the Spreadsheets skill discussion bridge: inspect sheets, fields, row patterns, formulas if visible, anomalies, trends, missing columns, and next analysis steps.",
      "If exact calculations are needed, ask the user to confirm the target sheet/range or request a generated analysis workbook."
    ],
    content: compactText(file.extractedText || file.summary || "", 4000)
  };
}

function buildPresentationAnalysisPayload(file: DiscuzFile, focus: string) {
  const slides = (file.extractedText || "")
    .split(/\n\n(?=Slide \d+)/)
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section, index) => {
      const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
      return {
        number: Number(lines[0]?.match(/\d+/)?.[0] || index + 1),
        title: lines[1] || `Slide ${index + 1}`,
        text: lines.slice(1, 7)
      };
    });
  return {
    ok: true,
    mode: "presentation",
    file: { id: file.id, name: file.originalName, role: file.role, kind: file.kind, summary: file.summary },
    focus,
    structure: {
      slideCount: slides.length,
      slides: slides.slice(0, 12)
    },
    instructions: [
      "Use the Presentations skill discussion bridge: review narrative spine, slide claims, proof objects, flow, audience fit, missing evidence, and improvement opportunities.",
      "Do not claim visual slide QA unless the deck is rendered and inspected separately."
    ],
    content: compactText(file.extractedText || file.summary || "", 4000)
  };
}

function fileBrief(file: DiscuzFile) {
  return {
    id: file.id,
    name: file.originalName,
    role: file.role,
    kind: file.kind,
    summary: compactText(file.summary || file.extractedText || "", 220),
    previewUrl: file.previewUrl
  };
}

function selectFileByQuery(files: DiscuzFile[], query = "", role?: DiscuzFile["role"], kinds?: DiscuzFile["kind"][]) {
  const queryText = query.trim().toLowerCase();
  return files.find((file) => {
    const roleMatches = !role || file.role === role;
    const kindMatches = !kinds || kinds.includes(file.kind);
    const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
    return roleMatches && kindMatches && nameMatches;
  }) ?? files.find((file) => (!role || file.role === role) && (!kinds || kinds.includes(file.kind))) ?? null;
}

function markdownTable(headers: string[], rows: string[][]) {
  const safeHeaders = headers.map((header) => header.trim() || "列");
  const safeRows = rows.map((row) => safeHeaders.map((_, index) => String(row[index] || "").replace(/\n/g, " ").trim()));
  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${safeHeaders.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function exportFileName(title: string) {
  const safeTitle = title
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "讨论记录";
  const stamp = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date()).replace(/[/:]/g, "-").replace(/\s+/g, "");
  return `${safeTitle}-${stamp}.md`;
}

function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadUploadedFile(file: DiscuzFile) {
  const anchor = document.createElement("a");
  anchor.href = file.previewUrl;
  anchor.download = file.originalName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function fileExtractionLabel(file: DiscuzFile) {
  if (file.kind === "image") return "后台识别图片";
  if (file.kind === "spreadsheet") return "后台解析表格";
  if (file.kind === "ppt" || file.kind === "pptx") return "后台解析PPT";
  if (file.kind === "doc" || file.kind === "docx") return "后台解析Word";
  if (file.kind === "epub") return "后台解析EPUB";
  if (file.kind === "pdf") return "后台解析PDF";
  return "后台解析文字";
}

function normalizeLines(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DiscuzFile["role"] | null>(null);
  const [draggingFile, setDraggingFile] = useState<{ id: string; role: DiscuzFile["role"] } | null>(null);
  const [webEnabled, setWebEnabled] = useState(true);
  const [meetingRecordEnabled, setMeetingRecordEnabled] = useState(() => localStorage.getItem("discuz-meeting-record-enabled") !== "false");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [directionProposal, setDirectionProposal] = useState<DirectionProposal | null>(null);
  const [settingsPopoverStyle, setSettingsPopoverStyle] = useState<CSSProperties>({});
  const [micPermissionOpen, setMicPermissionOpen] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState(() => localStorage.getItem("discuz-audio-input-id") || "");
  const [leftWidth, setLeftWidth] = useState(63);
  const [topHeight, setTopHeight] = useState(70);
  const [generatedHeight, setGeneratedHeight] = useState(40);
  const [layoutScale, setLayoutScale] = useState(1);
  const [fullscreenPanel, setFullscreenPanel] = useState<PanelId | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [previewRecordId, setPreviewRecordId] = useState<string | null>(null);
  const [generatedEditorId, setGeneratedEditorId] = useState<string | null>(null);
  const [webPreview, setWebPreview] = useState<WebPreview | null>(null);
  const [discussionText, setDiscussionText] = useState("");
  const [diagnosticInput, setDiagnosticInput] = useState("");
  const [topicProposal, setTopicProposal] = useState<TopicProposal | null>(null);
  const [draftText, setDraftText] = useState(() => localStorage.getItem("discuz-draft") || "");
  const [boardItems, setBoardItems] = useState<BoardItem[]>(
    () => loadStoredJson("discuz-board-items", [])
  );
  const [boardLinks, setBoardLinks] = useState<BoardLink[]>(
    () => loadStoredJson("discuz-board-links", [])
  );
  const [discussionContract, setDiscussionContract] = useState<DiscussionContract | null>(
    () => loadStoredJson("discuz-discussion-contract", null)
  );
  const [discussionAgenda, setDiscussionAgenda] = useState<DiscussionAgendaItem[]>(
    () => loadStoredJson("discuz-discussion-agenda", [])
  );
  const [agendaLocked, setAgendaLocked] = useState(() => localStorage.getItem("discuz-agenda-locked") === "true");
  const [currentAgendaIndex, setCurrentAgendaIndex] = useState(() => Number(localStorage.getItem("discuz-current-agenda-index") || 0));
  const [responseScope, setResponseScope] = useState<ResponseScope>(
    () => loadStoredJson("discuz-response-scope", { maxSentences: 2, onePointOnly: true, mustAskFirst: false })
  );
  const [userCognitiveLoad, setUserCognitiveLoad] = useState<CognitiveLoad>(
    () => (localStorage.getItem("discuz-user-cognitive-load") as CognitiveLoad) || "step_by_step"
  );
  const [outputRubric, setOutputRubric] = useState<string[]>(
    () => loadStoredJson("discuz-output-rubric", [])
  );
  const [drawPoints, setDrawPoints] = useState<Array<{ id: string; x: number; y: number }>>(
    () => loadStoredJson("discuz-board-points", [])
  );
  const [drawing, setDrawing] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceInputLevel, setVoiceInputLevel] = useState(0);
  const [voiceOutputLevel, setVoiceOutputLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [statusText, setStatusText] = useState("Ready");
  const [error, setError] = useState("");
  const [pendingTasks, setPendingTasks] = useState<TaskItem[]>([]);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [breakUntil, setBreakUntil] = useState<string | null>(null);
  const [ambientMode, setAmbientMode] = useState(false);
  const [statusLog, setStatusLog] = useState<StatusLogEntry[]>(() => [{
    id: crypto.randomUUID(),
    kind: "status",
    text: "Ready",
    createdAt: new Date().toISOString()
  }]);
  const primaryInputRef = useRef<HTMLInputElement | null>(null);
  const contextInputRef = useRef<HTMLInputElement | null>(null);
  const generatedInputRef = useRef<HTMLInputElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLElement | null>(null);
  const topicPanelRef = useRef<HTMLElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const statusLogRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const realtimeSessionRef = useRef<RealtimeSession | null>(null);
  const executeRealtimeToolRef = useRef<((_name: string, _args: Record<string, any>) => Promise<unknown>) | null>(null);
  const topicProposalRef = useRef<TopicProposal | null>(null);
  const directionProposalRef = useRef<DirectionProposal | null>(null);
  const discussionTopicRef = useRef("");
  const directionsRef = useRef<DiscussionDirection[]>([]);
  const statusTextRef = useRef(statusText);
  const pendingTasksRef = useRef<TaskItem[]>([]);
  const visibleTasksRef = useRef<TaskItem[]>([]);
  const toolActivitiesRef = useRef<ToolActivity[]>([]);
  const diagnosticEventsRef = useRef<DiagnosticEvent[]>([]);
  const responseActiveRef = useRef(false);
  const responsePendingRef = useRef(false);
  const topicFileChangeBlocksTopicProposalRef = useRef(false);
  const voiceSessionRef = useRef(0);
  const voiceSessionStartedAtRef = useRef<string | null>(null);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const responseWatchdogTimerRef = useRef<number | null>(null);
  const responseTaskTimerRef = useRef<number | null>(null);
  const pendingDirectionsAfterTopicRef = useRef<{ title: string; attempts: number; awaitingPermission: boolean } | null>(null);
  const activeTaskFinishersRef = useRef<Record<string, (_failed?: boolean) => void>>({});
  const activeTaskLabelsRef = useRef<Record<string, string>>({});
  const activeTaskOrderRef = useRef<string[]>([]);
  const taskEpochRef = useRef(0);
  const voiceMeterRef = useRef<VoiceMeter | null>(null);
  const pendingVoiceStopAfterResponseRef = useRef<PendingVoiceStop>("none");
  const pendingTaskCountRef = useRef(0);
  const activeTaskLabelRef = useRef("");
  const backgroundParsingActiveRef = useRef(false);
  const backgroundParsingLabelRef = useRef("");
  const lastStatusLogRef = useRef("Ready");
  const lastErrorLogRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const userTranscriptRef = useRef("");
  const awaitingAssistantReplyRef = useRef(false);
  const assistantResponseHadOutputRef = useRef(false);
  const emptyResponseRetryCountRef = useRef(0);
  const emptyResponseRetryTimerRef = useRef<number | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const recordStreamRef = useRef<HTMLDivElement | null>(null);
  const [topicPreviewFrame, setTopicPreviewFrame] = useState<{ left: number; width: number } | null>(null);
  const [conversationRecorderSessionId] = useState(() => {
    if (typeof window === "undefined") return "diag-server";
    const next = `diag-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem("discuz-conversation-recorder-session", next);
    return next;
  });
  const conversationDiagnosticEventsRef = useRef<ConversationDiagnosticEvent[]>([]);
  const conversationDiagnosticPendingRef = useRef<ConversationDiagnosticEvent[]>([]);
  const conversationDiagnosticFlushTimerRef = useRef<number | null>(null);
  const lastRecordedMeetingMessageIdRef = useRef<string | null>(null);
  const backgroundTaskNotificationReadyRef = useRef(false);
  const notifiedBackgroundTaskIdsRef = useRef<Set<string>>(new Set());

  const flushConversationDiagnostics = useCallback(async () => {
    if (!isConversationRecorderEnabled()) return;
    const events = conversationDiagnosticPendingRef.current.splice(0);
    if (!events.length) return;
    try {
      await fetch("/api/diagnostics/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: conversationRecorderSessionId,
          events
        }),
        keepalive: true
      });
    } catch {
      conversationDiagnosticPendingRef.current = [...events.slice(-100), ...conversationDiagnosticPendingRef.current].slice(-200);
    }
  }, [conversationRecorderSessionId]);

  const recordConversationDiagnostic = useCallback((kind: string, detail: unknown = {}) => {
    if (!isConversationRecorderEnabled()) return;
    const event: ConversationDiagnosticEvent = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind,
      topicId: state.activeTopicId || undefined,
      detail: shrinkDiagnosticDetail(detail)
    };
    conversationDiagnosticEventsRef.current = [...conversationDiagnosticEventsRef.current.slice(-399), event];
    conversationDiagnosticPendingRef.current = [...conversationDiagnosticPendingRef.current, event].slice(-200);
    if (conversationDiagnosticFlushTimerRef.current) return;
    conversationDiagnosticFlushTimerRef.current = window.setTimeout(() => {
      conversationDiagnosticFlushTimerRef.current = null;
      flushConversationDiagnostics().catch(() => undefined);
    }, 1200);
  }, [flushConversationDiagnostics, state.activeTopicId]);

  const primaryFiles = useMemo(() => state.files.filter((file) => file.role === "primary"), [state.files]);
  const contextFiles = useMemo(() => state.files.filter((file) => file.role === "context"), [state.files]);
  const generatedFiles = useMemo(() => state.files.filter((file) => file.role === "generated"), [state.files]);
  const parsingFiles = useMemo(
    () => state.files.filter((file) => file.extractionStatus === "pending" || file.extractionStatus === "processing"),
    [state.files]
  );
  const hasParsingFiles = useMemo(
    () => parsingFiles.length > 0,
    [parsingFiles]
  );
  const backgroundParsingTasks = useMemo<TaskItem[]>(
    () => parsingFiles.map((file) => ({
      id: `parse-${file.id}`,
      label: fileExtractionLabel(file),
      startedAt: file.updatedAt || file.createdAt
    })),
    [parsingFiles]
  );
  const activeBackgroundTasks = useMemo(
    () => (state.backgroundTasks ?? []).filter((task) => task.status === "queued" || task.status === "running"),
    [state.backgroundTasks]
  );
  const backgroundQueueTasks = useMemo<TaskItem[]>(
    () => activeBackgroundTasks.map((task) => ({
      id: `background-${task.id}`,
      label: task.status === "queued" ? `后台排队：${task.title}` : `后台执行：${task.title}`,
      startedAt: task.startedAt || task.createdAt
    })),
    [activeBackgroundTasks]
  );
  const visibleTasks = useMemo(
    () => [...backgroundParsingTasks, ...backgroundQueueTasks, ...pendingTasks],
    [backgroundParsingTasks, backgroundQueueTasks, pendingTasks]
  );
  useEffect(() => {
    statusTextRef.current = statusText;
    pendingTasksRef.current = pendingTasks;
    visibleTasksRef.current = visibleTasks;
    toolActivitiesRef.current = toolActivities;
  }, [pendingTasks, statusText, toolActivities, visibleTasks]);
  useEffect(() => {
    recordConversationDiagnostic("status", { statusText, voiceState, visibleTasks: visibleTasks.map((task) => task.label) });
  }, [recordConversationDiagnostic, statusText, voiceState, visibleTasks]);
  useEffect(() => {
    recordConversationDiagnostic("tool_activities", { toolActivities: toolActivities.slice(0, 8) });
  }, [recordConversationDiagnostic, toolActivities]);
  useEffect(() => {
    recordConversationDiagnostic("discussion_topic", { discussionTopic: state.discussionTopic });
  }, [recordConversationDiagnostic, state.discussionTopic]);
  useEffect(() => {
    recordConversationDiagnostic("directions", { directions: state.directions });
  }, [recordConversationDiagnostic, state.directions]);
  useEffect(() => {
    if (topicProposal) recordConversationDiagnostic("topic_proposal", topicProposal);
  }, [recordConversationDiagnostic, topicProposal]);
  useEffect(() => {
    if (directionProposal) recordConversationDiagnostic("direction_proposal", directionProposal);
  }, [directionProposal, recordConversationDiagnostic]);
  useEffect(() => {
    const latest = state.meetingMessages[state.meetingMessages.length - 1];
    if (!latest) return;
    if (lastRecordedMeetingMessageIdRef.current === null) {
      lastRecordedMeetingMessageIdRef.current = latest.id;
      recordConversationDiagnostic("meeting_message_snapshot", latest);
      return;
    }
    if (lastRecordedMeetingMessageIdRef.current === latest.id) return;
    lastRecordedMeetingMessageIdRef.current = latest.id;
    recordConversationDiagnostic("meeting_message", latest);
  }, [recordConversationDiagnostic, state.meetingMessages]);
  useEffect(() => {
    const heartbeat = window.setInterval(() => {
      recordConversationDiagnostic("heartbeat", {
        statusText: statusTextRef.current,
        voiceState,
        responseActive: responseActiveRef.current,
        responsePending: responsePendingRef.current,
        pendingTaskCount: pendingTaskCountRef.current,
        visibleTasks: visibleTasksRef.current.map((task) => task.label),
        toolActivities: toolActivitiesRef.current.slice(0, 6),
        meetingMessageCount: state.meetingMessages.length,
        directionCount: directionsRef.current.length,
        topic: discussionTopicRef.current
      });
      flushConversationDiagnostics().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(heartbeat);
  }, [flushConversationDiagnostics, recordConversationDiagnostic, state.meetingMessages.length, voiceState]);
  useEffect(() => {
    recordConversationDiagnostic("recorder_ready", {
      sessionId: conversationRecorderSessionId,
      enabled: isConversationRecorderEnabled()
    });
    const flushOnPageHide = () => {
      const events = conversationDiagnosticPendingRef.current.splice(0);
      if (!events.length) return;
      const body = JSON.stringify({ sessionId: conversationRecorderSessionId, events });
      navigator.sendBeacon?.("/api/diagnostics/events", new Blob([body], { type: "application/json" }));
    };
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      if (conversationDiagnosticFlushTimerRef.current) window.clearTimeout(conversationDiagnosticFlushTimerRef.current);
      flushConversationDiagnostics().catch(() => undefined);
    };
  }, [conversationRecorderSessionId, flushConversationDiagnostics, recordConversationDiagnostic]);
  const selectedFile = useMemo(
    () => state.files.find((file) => file.id === selectedId) ?? primaryFiles[0] ?? null,
    [state.files, selectedId, primaryFiles]
  );
  const previewFile = useMemo(
    () => state.files.find((file) => file.id === previewFileId) ?? null,
    [state.files, previewFileId]
  );
  const previewRecord = useMemo(
    () => state.records.find((record) => record.id === previewRecordId) ?? null,
    [state.records, previewRecordId]
  );
  useEffect(() => {
    topicProposalRef.current = topicProposal;
  }, [topicProposal]);
  useEffect(() => {
    directionProposalRef.current = directionProposal;
  }, [directionProposal]);
  useEffect(() => {
    discussionTopicRef.current = state.discussionTopic;
    directionsRef.current = state.directions;
  }, [state.discussionTopic, state.directions]);
  const generatedEditorFile = useMemo(
    () => state.files.find((file) => file.id === generatedEditorId) ?? null,
    [state.files, generatedEditorId]
  );
  const currentNotes = useMemo(() => [...state.notes].reverse(), [state.notes]);
  const meetingMessages = useMemo(() => [...(state.meetingMessages ?? [])].reverse(), [state.meetingMessages]);
  const rightResourceHeight = Math.max(22, Math.min(52, topHeight - 30));
  const rightRecordHeight = Math.max(12, 100 - rightResourceHeight - generatedHeight);

  const buildMeetingRecordMarkdown = useCallback(() => [
    `# ${state.discussionTopic ? `${state.discussionTopic} - 会议记录` : "会议记录"}`,
    "",
    `导出时间：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`,
    "",
    ...(meetingMessages.length
      ? meetingMessages.map((message) => `- ${message.role === "assistant" ? "AI" : "用户"}｜${shortTime(message.createdAt)}：${message.text}`)
      : ["暂无会议记录"])
  ].join("\n"), [meetingMessages, state.discussionTopic]);

  const buildNotesMarkdown = useCallback(() => [
    `# ${state.discussionTopic ? `${state.discussionTopic} - 要点` : "讨论要点"}`,
    "",
    `导出时间：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`,
    "",
    ...(currentNotes.length
      ? currentNotes.map((note) => `- ${noteLabel(note.kind)}｜${shortTime(note.createdAt)}｜${note.source || "AI summary"}：${note.text}`)
      : ["暂无要点"])
  ].join("\n"), [currentNotes, state.discussionTopic]);

  const buildDiscussionRecordMarkdown = useCallback((title = "讨论记录") => [
    `# ${title.replace(/\.md$/i, "")}`,
    state.discussionTopic ? `主题：${state.discussionTopic}` : "",
    "",
    "## 会议记录",
    ...(state.meetingMessages.length ? state.meetingMessages.map((message) => `- ${message.role === "user" ? "用户" : "AI"}｜${shortTime(message.createdAt)}：${message.text}`) : ["暂无会议记录"]),
    "",
    "## 要点",
    ...(state.notes.length ? state.notes.map((note) => `- ${noteLabel(note.kind)}｜${shortTime(note.createdAt)}：${note.text}`) : ["暂无要点"]),
    "",
    "## 讨论方向",
    ...(state.directions.length ? state.directions.map((direction) => `- ${direction.completed ? "[x]" : "[ ]"} ${direction.text}`) : ["暂无讨论方向"])
  ].filter(Boolean).join("\n"), [state.directions, state.discussionTopic, state.meetingMessages, state.notes]);

  const exportMeetingRecord = useCallback(() => {
    downloadMarkdown(exportFileName(`${state.discussionTopic || "当前讨论"}-会议记录`), buildMeetingRecordMarkdown());
    setStatusText("会议记录已导出");
  }, [buildMeetingRecordMarkdown, state.discussionTopic]);

  const exportNotes = useCallback(() => {
    downloadMarkdown(exportFileName(`${state.discussionTopic || "当前讨论"}-要点`), buildNotesMarkdown());
    setStatusText("要点已导出");
  }, [buildNotesMarkdown, state.discussionTopic]);

  const loadState = useCallback(async (preferredSelectedId?: string | null) => {
    const response = await fetch("/api/state");
    const nextState = await response.json();
    setState(nextState);
    if (preferredSelectedId) {
      setSelectedId(preferredSelectedId);
    } else if (!selectedId) {
      const primary = nextState.files.find((file: DiscuzFile) => file.role === "primary");
      setSelectedId(primary?.id ?? nextState.files[0]?.id ?? null);
    }
  }, [selectedId]);

  useEffect(() => {
    loadState().catch((err) => setError(err.message));
  }, [loadState]);

  useEffect(() => {
    if (!hasParsingFiles && !activeBackgroundTasks.length) return;
    const timer = window.setInterval(() => {
      loadState().catch((err) => setError(err.message));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeBackgroundTasks.length, hasParsingFiles, loadState]);

  useEffect(() => {
    if (parsingFiles.length) {
      backgroundParsingActiveRef.current = true;
      const label = parsingFiles.length === 1 ? fileExtractionLabel(parsingFiles[0]) : `后台解析/识别 ${parsingFiles.length} 个文件`;
      backgroundParsingLabelRef.current = label;
      if (pendingTaskCountRef.current === 0) setStatusText(`${label}进行中`);
      return;
    }
    if (backgroundParsingActiveRef.current) {
      backgroundParsingActiveRef.current = false;
      backgroundParsingLabelRef.current = "";
      if (pendingTaskCountRef.current === 0) setStatusText("后台解析/识别完成");
    }
  }, [parsingFiles]);

  useEffect(() => {
    localStorage.setItem("discuz-draft", draftText);
  }, [draftText]);

  useEffect(() => {
    const updateLayoutScale = () => {
      const widthScale = window.innerWidth / 1440;
      const heightScale = window.innerHeight / 900;
      const nextScale = Math.min(1, Math.max(0.68, Math.min(widthScale, heightScale)));
      setLayoutScale(Number(nextScale.toFixed(3)));
    };
    updateLayoutScale();
    window.addEventListener("resize", updateLayoutScale);
    return () => window.removeEventListener("resize", updateLayoutScale);
  }, []);

  useEffect(() => {
    localStorage.setItem("discuz-audio-input-id", selectedAudioInputId);
  }, [selectedAudioInputId]);

  useEffect(() => {
    localStorage.setItem("discuz-meeting-record-enabled", String(meetingRecordEnabled));
  }, [meetingRecordEnabled]);

  useEffect(() => {
    localStorage.setItem("discuz-board-items", JSON.stringify(boardItems));
  }, [boardItems]);

  useEffect(() => {
    localStorage.setItem("discuz-board-links", JSON.stringify(boardLinks));
  }, [boardLinks]);

  useEffect(() => {
    localStorage.setItem("discuz-board-points", JSON.stringify(drawPoints));
  }, [drawPoints]);

  useEffect(() => {
    localStorage.setItem("discuz-discussion-contract", JSON.stringify(discussionContract));
  }, [discussionContract]);

  useEffect(() => {
    localStorage.setItem("discuz-discussion-agenda", JSON.stringify(discussionAgenda));
  }, [discussionAgenda]);

  useEffect(() => {
    localStorage.setItem("discuz-agenda-locked", String(agendaLocked));
  }, [agendaLocked]);

  useEffect(() => {
    localStorage.setItem("discuz-current-agenda-index", String(currentAgendaIndex));
  }, [currentAgendaIndex]);

  useEffect(() => {
    localStorage.setItem("discuz-response-scope", JSON.stringify(responseScope));
  }, [responseScope]);

  useEffect(() => {
    localStorage.setItem("discuz-user-cognitive-load", userCognitiveLoad);
  }, [userCognitiveLoad]);

  useEffect(() => {
    localStorage.setItem("discuz-output-rubric", JSON.stringify(outputRubric));
  }, [outputRubric]);

  useEffect(() => {
    if (!breakUntil) return;
    const updateBreakStatus = () => {
      const remainingMs = new Date(breakUntil).getTime() - Date.now();
      if (remainingMs <= 0) {
        setBreakUntil(null);
        setStatusText("休息结束，可以继续讨论");
        return;
      }
      const minutes = Math.floor(remainingMs / 60000);
      const seconds = Math.ceil((remainingMs % 60000) / 1000);
      setStatusText(`休息中 ${minutes}:${String(seconds).padStart(2, "0")}`);
    };
    updateBreakStatus();
    const timer = window.setInterval(updateBreakStatus, 1000);
    return () => window.clearInterval(timer);
  }, [breakUntil]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (settingsPopoverRef.current?.contains(target)) return;
      if (settingsButtonRef.current?.contains(target)) return;
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [settingsOpen]);

  const positionSettingsPopover = useCallback(() => {
    const button = settingsButtonRef.current;
    if (!button) return;
    const scale = Math.max(layoutScale, 0.01);
    const rect = button.getBoundingClientRect();
    const margin = 12;
    const preferredWidth = 460 * scale;
    const physicalWidth = Math.min(preferredWidth, Math.max(240, window.innerWidth - margin * 2));
    const measuredHeight = settingsPopoverRef.current?.getBoundingClientRect().height;
    const fallbackHeight = Math.min(620 * scale, Math.max(220, window.innerHeight - margin * 2));
    const physicalHeight = Math.min(measuredHeight || fallbackHeight, window.innerHeight - margin * 2);
    const left = Math.min(Math.max(margin, rect.right - physicalWidth), window.innerWidth - physicalWidth - margin);
    const preferredTop = rect.bottom + 8 * scale;
    const top = Math.min(Math.max(margin, preferredTop), window.innerHeight - physicalHeight - margin);
    setSettingsPopoverStyle({
      left: left / scale,
      right: "auto",
      top: top / scale,
      maxWidth: (window.innerWidth - margin * 2) / scale,
      maxHeight: (window.innerHeight - margin * 2) / scale
    });
  }, [layoutScale]);

  const toggleSettingsPopover = () => {
    if (!settingsOpen) positionSettingsPopover();
    setSettingsOpen((value) => !value);
  };

  useEffect(() => {
    if (!settingsOpen) return;
    positionSettingsPopover();
    const frameId = window.requestAnimationFrame(positionSettingsPopover);
    window.addEventListener("resize", positionSettingsPopover);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", positionSettingsPopover);
    };
  }, [layoutScale, positionSettingsPopover, settingsOpen]);

  useEffect(() => {
    if (recordStreamRef.current) {
      recordStreamRef.current.scrollTop = recordStreamRef.current.scrollHeight;
    }
  }, [state.meetingMessages.length]);

  useEffect(() => {
    if (!previewFile || previewFile.role !== "primary") {
      setTopicPreviewFrame(null);
      return;
    }
    const updateTopicPreviewFrame = () => {
      const rect = topicPanelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTopicPreviewFrame({ left: rect.left, width: rect.width });
    };
    updateTopicPreviewFrame();
    const frameId = window.requestAnimationFrame(updateTopicPreviewFrame);
    window.addEventListener("resize", updateTopicPreviewFrame);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateTopicPreviewFrame);
    };
  }, [fullscreenPanel, layoutScale, leftWidth, previewFile]);

  const refreshAudioInputDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioInputDevices([]);
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    setAudioInputDevices(inputs);
    if (selectedAudioInputId && !inputs.some((device) => device.deviceId === selectedAudioInputId)) {
      setSelectedAudioInputId("");
    }
  }, [selectedAudioInputId]);

  useEffect(() => {
    refreshAudioInputDevices().catch(() => undefined);
    if (!navigator.mediaDevices?.addEventListener) return;
    navigator.mediaDevices.addEventListener("devicechange", refreshAudioInputDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshAudioInputDevices);
  }, [refreshAudioInputDevices]);

  useEffect(() => {
    if (statusLogRef.current) {
      statusLogRef.current.scrollTop = statusLogRef.current.scrollHeight;
    }
  }, [statusLog.length, transcript]);

  useEffect(() => {
    const text = statusText.trim();
    if (!text || text === lastStatusLogRef.current) return;
    lastStatusLogRef.current = text;
    setStatusLog((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: "status" as const, text, createdAt: new Date().toISOString() }
    ].slice(-80));
  }, [statusText]);

  useEffect(() => {
    const text = error.trim();
    if (!text) {
      lastErrorLogRef.current = "";
      return;
    }
    if (text === lastErrorLogRef.current) return;
    lastErrorLogRef.current = text;
    setStatusLog((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: "error" as const, text, createdAt: new Date().toISOString() }
    ].slice(-80));
  }, [error]);

  const startColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = leftWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientX - startX) / window.innerWidth) * 100;
      setLeftWidth(Math.min(76, Math.max(46, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startRowResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = topHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientY - startY) / window.innerHeight) * 100;
      setTopHeight(Math.min(84, Math.max(25, startHeight + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startGeneratedRecordResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = generatedHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientY - startY) / window.innerHeight) * 100;
      setGeneratedHeight(Math.min(48, Math.max(14, startHeight + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const applyLayoutCommand = (target: PanelId | "reset", mode: string) => {
    if (target === "reset" || mode === "reset") {
      setLeftWidth(63);
      setTopHeight(70);
      setGeneratedHeight(40);
      setFullscreenPanel(null);
      return;
    }
    if (mode === "fullscreen") setFullscreenPanel(target);
    if (mode === "focus") {
      setFullscreenPanel(null);
      if (target === "topic") setLeftWidth(74);
      if (target === "resources") {
        setLeftWidth(50);
        setTopHeight(78);
        setGeneratedHeight(18);
      }
      if (target === "generated") {
        setLeftWidth(50);
        setTopHeight(54);
        setGeneratedHeight(42);
      }
      if (target === "record") {
        setLeftWidth(50);
        setTopHeight(32);
        setGeneratedHeight(16);
      }
    }
  };

  const beginTask = useCallback((label: string) => {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const epoch = taskEpochRef.current;
    activeTaskLabelsRef.current[id] = label;
    activeTaskOrderRef.current = [...activeTaskOrderRef.current.filter((taskId) => taskId !== id), id];
    pendingTaskCountRef.current = activeTaskOrderRef.current.length;
    activeTaskLabelRef.current = label;
    if (isDiagnosticsEnabled()) {
      diagnosticEventsRef.current = [
        ...diagnosticEventsRef.current.slice(-199),
        { type: "task:start", id, label, at: startedAt }
      ];
    }
    setPendingTasks((current) => [...current.filter((task) => task.id !== id), { id, label, startedAt }]);
    setStatusText(`${label}进行中`);
    recordConversationDiagnostic("task:start", { id, label, startedAt });
    let finishing = false;
    let completed = false;
    return (failed = false) => {
      if (finishing || completed) return;
      finishing = true;
      const complete = () => {
        if (completed) return;
        if (epoch !== taskEpochRef.current) {
          completed = true;
          return;
        }
        completed = true;
        if (isDiagnosticsEnabled()) {
          diagnosticEventsRef.current = [
            ...diagnosticEventsRef.current.slice(-199),
            { type: "task:finish", id, label, at: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs }
          ];
        }
        delete activeTaskLabelsRef.current[id];
        activeTaskOrderRef.current = activeTaskOrderRef.current.filter((taskId) => taskId !== id);
        pendingTaskCountRef.current = activeTaskOrderRef.current.length;
        setPendingTasks((current) => current.filter((task) => task.id !== id));
        if (pendingTaskCountRef.current > 0) {
          const activeId = activeTaskOrderRef.current[activeTaskOrderRef.current.length - 1];
          const activeLabel = activeTaskLabelsRef.current[activeId] || "任务";
          activeTaskLabelRef.current = activeLabel;
          setStatusText(pendingTaskCountRef.current > 1 ? `正在执行 ${pendingTaskCountRef.current} 个任务` : `${activeLabel}进行中`);
        } else {
          activeTaskLabelRef.current = "";
          if (backgroundParsingActiveRef.current && backgroundParsingLabelRef.current) {
            setStatusText(`${backgroundParsingLabelRef.current}进行中`);
          } else {
            setStatusText(`${label}${failed ? "失败" : "完成"}`);
          }
        }
        recordConversationDiagnostic("task:finish", { id, label, failed, elapsedMs: Date.now() - startedAtMs });
      };
      const remainingMs = Math.max(0, 900 - (Date.now() - startedAtMs));
      if (remainingMs > 0) window.setTimeout(complete, remainingMs);
      else complete();
    };
  }, [recordConversationDiagnostic]);

  const beginUniqueTask = useCallback((key: string, label: string) => {
    const existing = activeTaskFinishersRef.current[key];
    if (existing) return existing;
    const finishTask = beginTask(label);
    const finish = (failed = false) => {
      if (!activeTaskFinishersRef.current[key]) return;
      delete activeTaskFinishersRef.current[key];
      finishTask(failed);
    };
    activeTaskFinishersRef.current[key] = finish;
    return finish;
  }, [beginTask]);

  const finishUniqueTask = useCallback((key: string) => {
    activeTaskFinishersRef.current[key]?.();
  }, []);

  const finishAllVisibleTasks = useCallback(() => {
    if (isDiagnosticsEnabled() && activeTaskOrderRef.current.length) {
      const cancelledAt = new Date().toISOString();
      const cancelledEvents = activeTaskOrderRef.current.map((id) => ({
        type: "task:cancel" as const,
        id,
        label: activeTaskLabelsRef.current[id] || "任务",
        at: cancelledAt
      }));
      diagnosticEventsRef.current = [
        ...diagnosticEventsRef.current.slice(-199),
        ...cancelledEvents
      ].slice(-200);
    }
    taskEpochRef.current += 1;
    recordConversationDiagnostic("task:cancel_all", { ids: activeTaskOrderRef.current, labels: activeTaskLabelsRef.current });
    activeTaskFinishersRef.current = {};
    activeTaskLabelsRef.current = {};
    activeTaskOrderRef.current = [];
    if (responseTaskTimerRef.current) window.clearTimeout(responseTaskTimerRef.current);
    responseTaskTimerRef.current = null;
    pendingTaskCountRef.current = 0;
    activeTaskLabelRef.current = "";
    setPendingTasks([]);
  }, [recordConversationDiagnostic]);

  const scheduleResponseTask = useCallback((label = "AI整理结果") => {
    if (responseTaskTimerRef.current || activeTaskFinishersRef.current.response) return;
    responseTaskTimerRef.current = window.setTimeout(() => {
      responseTaskTimerRef.current = null;
      if (!responseActiveRef.current || pendingTaskCountRef.current > 0) return;
      beginUniqueTask("response", label);
    }, 650);
  }, [beginUniqueTask]);

  const finishResponseTask = useCallback(() => {
    if (responseTaskTimerRef.current) window.clearTimeout(responseTaskTimerRef.current);
    responseTaskTimerRef.current = null;
    finishUniqueTask("response");
  }, [finishUniqueTask]);

  const summarizeToolResult = (value: unknown) => {
    const result = value as Record<string, unknown>;
    if (result?.error) return String(result.error);
    if (typeof result?.resultText === "string") {
      if (typeof result.title === "string" && typeof result.url === "string") {
        return `已读取：${result.title}，${compactText(result.resultText, 220)}`;
      }
      const count = typeof result.count === "number" ? `找到 ${result.count} 条结果` : "搜索完成";
      return `${count}：${compactText(result.resultText, 260)}`;
    }
    if (Array.isArray(result?.results)) {
      const items = result.results as Array<{ title?: string; url?: string }>;
      const titles = items.slice(0, 3).map((item, index) => `${index + 1}. ${item.title || item.url || "Untitled"}`).join("；");
      return items.length ? `找到 ${items.length} 条结果：${titles}` : "没有找到可用搜索结果";
    }
    if (result?.opened) return `已打开：${String(result.opened)}`;
    if (result?.generated) return `已生成：${String(result.generated)}`;
    if (result?.downloaded) return `已下载：${String(result.downloaded)}`;
    if (result?.saved) return `已保存：${String(result.saved)}`;
    if (result?.analysis) return compactText(String(result.analysis), 120);
    if (result?.paused) return "已暂停等待";
    if (result?.breakUntil) return "休息计时已开始";
    return compactText(JSON.stringify(value), 140);
  };

  const compactToolOutputForRealtime = (name: string, value: unknown): unknown => {
    const result = value as Record<string, unknown>;
    if (result?.error || result?.ok === false) {
      return { ok: false, error: compactText(String(result.error || "Tool failed"), 240) };
    }
    const wantsStructuredList = (text: unknown) => /全部|完整|所有|列表|清单|日程|赛程|赛果|比赛|名单|价格|步骤|对比|证据|引用|all|full|list|schedule|fixture|price|steps|compare|evidence/i.test(String(text || ""));
    const compactDetails = (details: unknown) => {
      if (!details || typeof details !== "object") return undefined;
      const output: Record<string, string> = {};
      Object.entries(details as Record<string, unknown>).slice(0, 10).forEach(([key, entry]) => {
        const text = Array.isArray(entry) ? entry.join(" / ") : String(entry || "");
        const compacted = compactText(text, 180).replace(/\n/g, " ").trim();
        if (compacted) output[key] = compacted;
      });
      return Object.keys(output).length ? output : undefined;
    };
    if (name === "search_context") {
      const maxResults = wantsStructuredList(result.query) ? 6 : 4;
      const results = Array.isArray(result.results) ? result.results.slice(0, maxResults) : [];
      return { ok: true, query: result.query, results };
    }
    if (name === "web_search") {
      const resultType = String(result.resultType || "");
      const sourceItems = Array.isArray(result.cards) ? result.cards : Array.isArray(result.results) ? result.results : [];
      const keepCount = /schedule|list|price|steps|compare|ranking|日程|赛程|比赛|列表|清单|价格|步骤|对比|排名/i.test(resultType) ? 20 : 6;
      const cards = sourceItems.slice(0, keepCount).map((item: any) => ({
        title: compactText(String(item.title || ""), 120),
        url: String(item.url || ""),
        snippet: compactText(String(item.snippet || ""), 220),
        details: compactDetails(item.details)
      }));
      return {
        ok: true,
        resultType,
        answer: compactText(String(result.answer || ""), 700),
        count: result.count ?? cards.length,
        cards,
        results: cards
      };
    }
    if (name === "read_web_page") {
      return {
        ok: true,
        title: compactText(String(result.title || ""), 120),
        url: String(result.url || ""),
        source: result.source,
        text: compactText(String(result.text || result.resultText || ""), 2500)
      };
    }
    if (["analyze_word_file", "analyze_spreadsheet_file", "analyze_presentation_file", "compare_files"].includes(name)) {
      return {
        ok: true,
        mode: result.mode,
        file: result.file,
        files: result.files,
        focus: compactText(String(result.focus || ""), 120),
        structure: result.structure,
        content: compactText(String(result.content || result.firstContent || ""), 1800),
        secondContent: result.secondContent ? compactText(String(result.secondContent), 1800) : undefined
      };
    }
    if (name === "get_discussion_state") {
      return result;
    }
    const importantKeys = [
      "ok", "opened", "generated", "downloaded", "saved", "copied", "moved", "added", "updated",
      "route", "reason", "queued", "taskId", "status", "postActions", "prepared", "confirmed", "count", "title", "ambientMode", "cancelled", "ending", "next"
    ];
    const output: Record<string, unknown> = {};
    importantKeys.forEach((key) => {
      if (key in result) output[key] = typeof result[key] === "string" ? compactText(String(result[key]), 240) : result[key];
    });
    if (Object.keys(output).length) return output;
    return { ok: true, summary: compactText(JSON.stringify(value), 360) };
  };

  const createToolActivity = (label: string, detail = "") => {
    const id = crypto.randomUUID();
    const activity: ToolActivity = {
      id,
      label,
      status: "running",
      startedAt: new Date().toISOString(),
      detail
    };
    setToolActivities((items) => [activity, ...items].slice(0, 12));
    recordConversationDiagnostic("tool:start", activity);
    return id;
  };

  const updateToolActivity = (id: string, patch: Partial<ToolActivity>) => {
    setToolActivities((items) => items.map((item) => {
      if (item.id !== id) return item;
      if (item.status === "cancelled" && patch.status && patch.status !== "cancelled") {
        return { ...item, result: item.result ?? patch.result, endedAt: item.endedAt ?? patch.endedAt };
      }
      return { ...item, ...patch, endedAt: patch.endedAt ?? item.endedAt };
    }));
    recordConversationDiagnostic("tool:update", { id, patch });
  };

  const showPendingExtractionStatus = (files: DiscuzFile[]) => {
    const pending = files.filter((file) => file.extractionStatus === "pending" || file.extractionStatus === "processing");
    if (!pending.length) return;
    const label = pending.length === 1 ? fileExtractionLabel(pending[0]) : `后台解析/识别 ${pending.length} 个文件`;
    backgroundParsingActiveRef.current = true;
    backgroundParsingLabelRef.current = label;
    setStatusText(`${label}进行中`);
  };

  const setPrimary = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const finishTask = beginTask("上传主题文件");
    try {
      const payload = await uploadFiles("/api/files/primary", "files", list);
      setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
      setSelectedId(payload.uploaded?.[0]?.id ?? payload.file?.id ?? selectedId);
      const uploaded = (payload.uploaded ?? (payload.file ? [payload.file] : [])) as DiscuzFile[];
      showPendingExtractionStatus(uploaded);
      notifyPrimaryFilesAdded(uploaded);
      setError("");
    } finally {
      finishTask();
    }
  };

  const addContext = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const finishTask = beginTask("上传资源文件");
    try {
      const payload = await uploadFiles("/api/files/context", "files", list);
      setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
      showPendingExtractionStatus((payload.uploaded ?? (payload.file ? [payload.file] : [])) as DiscuzFile[]);
      setError("");
    } finally {
      finishTask();
    }
  };

  const addGeneratedFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const finishTask = beginTask("上传临时文件");
    try {
      const payload = await uploadFiles("/api/files/generated/upload", "files", list);
      setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
      showPendingExtractionStatus((payload.uploaded ?? (payload.file ? [payload.file] : [])) as DiscuzFile[]);
      setGeneratedEditorId(null);
      setWebPreview(null);
      setError("");
    } finally {
      finishTask();
    }
  };

  const saveNote = async (text: string, kind: Note["kind"] = "point", source = "AI") => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, text: trimmed, source })
    });
    if (response.ok) {
      const payload = await response.json();
      setState((current) => ({ ...current, notes: payload.notes }));
    }
  };

  const saveMeetingMessage = async (text: string, role: MeetingMessage["role"]) => {
    const trimmed = text.trim();
    if (!meetingRecordEnabled) return;
    if (!trimmed) return;
    const response = await fetch("/api/meeting-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, text: trimmed })
    });
    if (response.ok) {
      const payload = await response.json();
      setState((current) => ({
        ...current,
        meetingMessages: payload.meetingMessages ?? current.meetingMessages,
        activities: payload.activities ?? current.activities
      }));
    }
  };

  const createGeneratedFile = async (title: string, text: string) => {
    const finishTask = beginTask("生成临时文案");
    try {
      const response = await fetch("/api/files/generated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, text })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        files: payload.files ?? current.files,
        activities: payload.activities ?? current.activities
      }));
      return payload.file as DiscuzFile;
    } finally {
      finishTask();
    }
  };

  const queueBackgroundTask = async (options: {
    kind?: "generic" | "file_analysis" | "web_search" | "report" | "code";
    title: string;
    prompt: string;
    outputMode?: "summary" | "file" | "both";
    targetFileIds?: string[];
    postActions?: Array<"add_to_topic" | "open_preview">;
  }) => {
    const response = await fetch("/api/background-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: options.kind || "generic",
        title: compactText(options.title || "后台任务", 80),
        prompt: compactText(options.prompt || "", 1200),
        outputMode: options.outputMode || "file",
        targetFileIds: options.targetFileIds ?? [],
        postActions: options.postActions ?? []
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to queue background task.");
    setState((current) => ({
      ...current,
      backgroundTasks: payload.backgroundTasks ?? current.backgroundTasks,
      activities: payload.activities ?? current.activities
    }));
    return payload.task as AppState["backgroundTasks"][number] | undefined;
  };

  const buildDiscussionWorkbenchMarkdown = () => {
    const topic = (state.discussionTopic || state.topics.find((topicItem) => topicItem.active)?.title || "待确认主题").trim();
    const directions = [...state.directions]
      .sort((first, second) => first.sortOrder - second.sortOrder)
      .slice(0, 8);
    const files = state.files
      .filter((file) => file.role === "primary" || file.role === "context")
      .slice(0, 10);
    const notes = state.notes.slice(-8);
    const safeCell = (value: string, maxChars = 120) => compactText(value || "", maxChars).replace(/\|/g, "/").replace(/\n/g, " ").trim();
    const directionLines = directions.length
      ? directions.map((direction, index) => `${index + 1}. ${direction.completed ? "[x]" : "[ ]"} ${compactText(direction.text, 140)}`)
      : ["1. [ ] 先确认本次最重要的讨论问题。"];
    const fileRows = files.map((file) => [
      file.role === "primary" ? "主题区" : "资料区",
      safeCell(file.originalName, 80),
      safeCell(file.summary || file.extractedText || "暂无摘要", 160)
    ]);
    const noteLines = notes.length
      ? notes.map((note) => `- ${noteLabel(note.kind)}：${compactText(note.text, 180)}`)
      : ["- 暂无已记录要点。"];
    return [
      `# ${topic} 讨论工作台`,
      `生成时间：${new Date().toLocaleString("zh-CN")}`,
      "## 讨论方向",
      directionLines.join("\n"),
      "## 资料简表",
      fileRows.length ? markdownTable(["位置", "文件", "摘要"], fileRows) : "暂无主题区或资料区文件。",
      "## 已记录要点",
      noteLines.join("\n"),
      "## 下一步",
      "- 从第一个未完成方向开始，每次只讨论一个问题。",
      "- 形成观点、结论、问题或行动项后直接记录为要点。"
    ].join("\n\n");
  };

  const generateImageFile = async (title: string, prompt: string, size = "1024x1024", quality = "high") => {
    const finishTask = beginTask("生成图片");
    try {
      const response = await fetch("/api/files/generated/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt, size, quality })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      const file = payload.file as DiscuzFile;
      setState((current) => ({
        ...current,
        files: payload.files ?? current.files,
        activities: payload.activities ?? current.activities,
        topics: payload.topics ?? current.topics
      }));
      if (file?.id) {
        setSelectedId(file.id);
        setPreviewFileId(file.id);
        setGeneratedEditorId(null);
        setPreviewRecordId(null);
        setActiveTool(null);
        setWebPreview(null);
      }
      return file;
    } finally {
      finishTask();
    }
  };

  const updateGeneratedFile = async (file: DiscuzFile, text: string) => {
    const finishTask = beginTask("保存文件编辑");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        files: payload.files ?? current.files,
        activities: payload.activities ?? current.activities
      }));
    } finally {
      finishTask();
    }
  };

  const promoteFileToPrimary = async (file: DiscuzFile, requireConfirm = false) => {
    if (file.role === "primary") return file;
    if (requireConfirm && !window.confirm(`将“${file.originalName}”确认为成果并存入讨论主题？`)) return null;
    const finishTask = beginTask("加入主题区");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/promote-primary`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        files: payload.files ?? current.files,
        activities: payload.activities ?? current.activities
      }));
      const nextFile = payload.file as DiscuzFile | undefined;
      setSelectedId(nextFile?.id ?? file.id);
      setGeneratedEditorId(null);
      notifyPrimaryFilesAdded(payload.file ? [payload.file as DiscuzFile] : [file]);
      await loadState(nextFile?.id ?? file.id);
      setError("");
      return payload.file as DiscuzFile;
    } finally {
      finishTask();
    }
  };

  const moveFileToRole = async (file: DiscuzFile, role: DiscuzFile["role"]) => {
    if (file.role === role) return file;
    const finishTask = beginTask("移动文件");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        files: payload.files ?? current.files,
        activities: payload.activities ?? current.activities
      }));
      const nextFile = payload.file as DiscuzFile | undefined;
      setSelectedId(nextFile?.id ?? file.id);
      if (role !== "generated") setGeneratedEditorId(null);
      if (previewFileId === file.id && role === "generated") setPreviewFileId(null);
      if (role === "primary") notifyPrimaryFilesAdded(payload.file ? [payload.file as DiscuzFile] : [file]);
      await loadState(nextFile?.id ?? file.id);
      setError("");
      return payload.file as DiscuzFile;
    } finally {
      finishTask();
    }
  };

  const copyFileToGenerated = async (file: DiscuzFile) => {
    const finishTask = beginTask("复制到临时区");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/copy-generated`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        files: payload.files ?? current.files,
        activities: payload.activities ?? current.activities
      }));
      const copiedFile = payload.file as DiscuzFile | undefined;
      setGeneratedEditorId(copiedFile && (copiedFile.kind === "markdown" || copiedFile.kind === "text") ? copiedFile.id : null);
      setSelectedId(payload.file?.id ?? file.id);
      await loadState(copiedFile?.id ?? file.id);
      setError("");
      return payload.file as DiscuzFile;
    } finally {
      finishTask();
    }
  };

  const clearResponseWatchdog = useCallback(() => {
    if (responseWatchdogTimerRef.current) window.clearTimeout(responseWatchdogTimerRef.current);
    responseWatchdogTimerRef.current = null;
  }, []);

  const startResponseWatchdog = useCallback(() => {
    clearResponseWatchdog();
    responseWatchdogTimerRef.current = window.setTimeout(() => {
      if (!responseActiveRef.current) return;
      realtimeSessionRef.current?.interrupt();
      responseActiveRef.current = false;
      responsePendingRef.current = false;
      finishAllVisibleTasks();
      setStatusText("上一轮响应超时，已恢复");
      setVoiceState((state) => state === "thinking" ? "live" : state);
    }, 30000);
  }, [clearResponseWatchdog, finishAllVisibleTasks]);

  const requestRealtimeResponse = useCallback(() => {
    const session = realtimeSessionRef.current;
    if (!session || typeof session.transport.requestResponse !== "function") return false;
    responsePendingRef.current = false;
    try {
      session.transport.requestResponse();
    } catch (error) {
      responsePendingRef.current = false;
      clearResponseWatchdog();
      finishResponseTask();
      setVoiceState("error");
      setError(error instanceof Error ? error.message : "Realtime response request failed");
      return false;
    }
    scheduleResponseTask("AI处理中");
    return true;
  }, [clearResponseWatchdog, finishResponseTask, scheduleResponseTask]);

  const clearEmptyResponseRetry = useCallback(() => {
    if (emptyResponseRetryTimerRef.current) window.clearTimeout(emptyResponseRetryTimerRef.current);
    emptyResponseRetryTimerRef.current = null;
  }, []);

  const scheduleEmptyResponseRetry = useCallback((activeSessionId: number, errorMessage = "") => {
    if (!awaitingAssistantReplyRef.current || emptyResponseRetryCountRef.current >= 1) return false;
    emptyResponseRetryCountRef.current += 1;
    clearEmptyResponseRetry();
    const delay = realtimeRetryDelayMs(errorMessage);
    setStatusText(delay > 1500 ? "上一轮被限流，稍后自动补答" : "上一轮没有出声，正在补答");
    emptyResponseRetryTimerRef.current = window.setTimeout(() => {
      emptyResponseRetryTimerRef.current = null;
      if (activeSessionId !== voiceSessionRef.current || !awaitingAssistantReplyRef.current) return;
      const session = realtimeSessionRef.current;
      if (!session) return;
      session.sendMessage([
        "系统事件：上一轮用户发言后没有产生可听回复，可能是临时限流或空响应。",
        "请直接回答用户刚才的问题，不要说你要执行什么任务；后台工具直接执行。",
        "如果已经形成观点、结论、风险或行动项，直接调用 save_discussion_note 记录，不要请求用户审批。"
      ].join("\n"));
    }, delay);
    return true;
  }, [clearEmptyResponseRetry]);

  const sendRealtimeSystemEvent = (text: string, options: { blockTopicProposal?: boolean } = {}) => {
    const session = realtimeSessionRef.current;
    if (!session) return false;
    if (options.blockTopicProposal) {
      topicFileChangeBlocksTopicProposalRef.current = true;
      window.setTimeout(() => {
        topicFileChangeBlocksTopicProposalRef.current = false;
      }, 18000);
    }
    session.sendMessage(text);
    return true;
  };

  useEffect(() => {
    const backgroundTasks = state.backgroundTasks ?? [];
    if (!backgroundTaskNotificationReadyRef.current) {
      backgroundTasks.forEach((task) => {
        if (task.status === "done" || task.status === "error") notifiedBackgroundTaskIdsRef.current.add(task.id);
      });
      backgroundTaskNotificationReadyRef.current = true;
      return;
    }
    backgroundTasks.forEach((task) => {
      if (task.status !== "done" && task.status !== "error") return;
      if (notifiedBackgroundTaskIdsRef.current.has(task.id)) return;
      notifiedBackgroundTaskIdsRef.current.add(task.id);
      setStatusText(task.status === "done" ? `后台任务完成：${task.title}` : `后台任务失败：${task.title}`);
      const postActions = task.postActions ?? [];
      if (task.status === "done" && task.resultFileId && postActions.length) {
        void (async () => {
          let openedName = task.resultFile?.name || task.title;
          if (postActions.includes("add_to_topic")) {
            const response = await fetch(`/api/files/${encodeURIComponent(task.resultFileId)}/promote-primary`, { method: "POST" });
            const payload = await response.json();
            if (response.ok) {
              const promotedFile = payload.file as DiscuzFile | undefined;
              openedName = promotedFile?.originalName || openedName;
              setState((current) => ({
                ...current,
                files: payload.files ?? current.files,
                activities: payload.activities ?? current.activities,
                topics: payload.topics ?? current.topics
              }));
            }
          }
          if (postActions.includes("open_preview")) {
            setSelectedId(task.resultFileId);
            setPreviewFileId(task.resultFileId);
            setGeneratedEditorId(null);
            setPreviewRecordId(null);
            setActiveTool(null);
            setWebPreview(null);
          }
          await loadState(task.resultFileId);
          setStatusText(`后台任务完成：${openedName}`);
        })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
      }
      const resultLine = task.status === "done"
        ? `结果文件：${task.resultFile?.name || task.resultFileId || "已生成"}；摘要：${compactText(task.resultSummary || "", 500)}`
        : `错误：${compactText(task.error || "后台任务失败", 400)}`;
      const actionLine = task.status === "done" && postActions.length
        ? `后续动作：${postActions.includes("add_to_topic") ? "加入主题区" : ""}${postActions.includes("open_preview") ? "，打开预览" : ""}`
        : "";
      sendRealtimeSystemEvent([
        `系统事件：后台任务“${task.title}”${task.status === "done" ? "已完成" : "失败"}。`,
        resultLine,
        actionLine,
        "请用一句话告诉用户结果已准备好；如果有结果文件，提示用户可以在 AI 临时文件区查看。"
      ].filter(Boolean).join("\n\n"));
    });
  }, [loadState, state.backgroundTasks]);

  const flushRealtimeResponse = useCallback(() => {
    if (!responsePendingRef.current) return;
    requestRealtimeResponse();
  }, [requestRealtimeResponse]);

  const finishPendingDirectionsAfterTopic = useCallback(() => {
    if (!pendingDirectionsAfterTopicRef.current) return;
    pendingDirectionsAfterTopicRef.current = null;
    finishUniqueTask("directions-after-topic");
  }, [finishUniqueTask]);

  const requestDirectionsAfterConfirmedTopic = useCallback(() => {
    const pending = pendingDirectionsAfterTopicRef.current;
    if (!pending) return false;
    if (pending.awaitingPermission) return false;
    if (directionProposalRef.current?.directions?.length || directionsRef.current.length) {
      finishPendingDirectionsAfterTopic();
      return false;
    }
    const session = realtimeSessionRef.current;
    if (!session || typeof session.transport.requestResponse !== "function") return false;
    if (pending.attempts >= 2) {
      finishPendingDirectionsAfterTopic();
      return false;
    }
    pending.attempts += 1;
    beginUniqueTask("directions-after-topic", "生成讨论方向");
    session.sendMessage([
      `系统事件：讨论主题《${pending.title}》已经确认，但界面还没有待确认的讨论方向。`,
      "请现在调用 prepare_discussion_directions，让后台模型基于当前主题、主题文件和用户输入提出 1 到 3 个方向供用户确认。",
      "只用自然短句提醒用户可以删改方向，不要再次确认主题，不要等待用户再次追问。"
    ].join("\n\n"));
    return true;
  }, [beginUniqueTask, finishPendingDirectionsAfterTopic]);

  const notifyForegroundDiscussion = (title: string, text: string) => {
    sendRealtimeSystemEvent(`系统事件：用户打开了前台讨论窗口《${title}》。这个窗口现在是当前临时讨论对象。以下是压缩摘要，精确细节请调用分析或检索工具。\n\n${compactText(text, 1200)}`);
  };

  const describeFileForDiscussion = (file: DiscuzFile) => {
    return [
      `文件名：${file.originalName}`,
      `区域：${file.role}`,
      `类型：${file.kind}`,
      file.summary ? `摘要：${compactText(file.summary, 260)}` : "",
      file.extractedText ? `片段：\n${compactText(file.extractedText, 1200)}` : "",
      file.previewUrl ? `预览地址：${file.previewUrl}` : ""
    ].filter(Boolean).join("\n\n");
  };

  const primaryFileChangeNames = (files: DiscuzFile[]) => files.map((file) => `《${file.originalName}》`).join("、");

  const notifyPrimaryFilesAdded = (files: DiscuzFile[]) => {
    if (!files.length) return;
    sendRealtimeSystemEvent(
      [
        `系统事件：用户刚刚在主题区添加了主题文件：${primaryFileChangeNames(files)}。`,
        "请立即用自然短句询问用户接下来想怎么讨论，不要使用固定问法。",
        "重要约束：不要调用 prepare_discussion_topic、prepare_discussion_directions、propose_discussion_topic、propose_discussion_directions 或 update_discussion_directions；不要修改、重命名、清空或重新确认当前讨论主题，除非用户下一句明确要求。"
      ].join("\n"),
      { blockTopicProposal: true }
    );
  };

  const notifyPrimaryFileDeleted = (file: DiscuzFile) => {
    sendRealtimeSystemEvent(
      [
        `系统事件：用户刚刚从主题区删除了主题文件《${file.originalName}》。`,
        "请立即用 1 句中文询问用户下一步要继续用剩余主题文件讨论、上传新的主题文件，还是暂停这个主题。",
        "重要约束：不要调用 prepare_discussion_topic、prepare_discussion_directions、propose_discussion_topic、propose_discussion_directions 或 update_discussion_directions；不要修改、重命名、清空或重新确认当前讨论主题，除非用户下一句明确要求。"
      ].join("\n"),
      { blockTopicProposal: true }
    );
  };

  const openFileDiscussionWindow = (file: DiscuzFile) => {
    setSelectedId(file.id);
    setActiveTool(null);
    setPreviewRecordId(null);
    setWebPreview(null);
    if (file.role === "generated" && (file.kind === "markdown" || file.kind === "text")) {
      setPreviewFileId(null);
      setGeneratedEditorId(file.id);
    } else {
      setGeneratedEditorId(null);
      setPreviewFileId(file.id);
    }
    notifyForegroundDiscussion(file.originalName, describeFileForDiscussion(file));
  };

  const openToolDiscussionWindow = (tool: ToolId) => {
    setPreviewFileId(null);
    setPreviewRecordId(null);
    setGeneratedEditorId(null);
    setWebPreview(null);
    setActiveTool(tool);
    if (tool === "draft") notifyForegroundDiscussion("临时文档", draftText || "当前临时文档为空。");
    if (tool === "whiteboard") notifyForegroundDiscussion("无限白板", boardToMarkdown());
  };

  const boardToMarkdown = () => {
    const textItems = boardItems
      .filter((item) => item.kind === "text" && item.value.trim())
      .map((item, index) => `${index + 1}. ${item.value.trim()}`)
      .join("\n");
    const imageItems = boardItems
      .filter((item) => item.kind === "image")
      .map((item, index) => `![白板图片 ${index + 1}](${item.value})`)
      .join("\n\n");
    const itemMap = new Map(boardItems.map((item) => [item.id, item.value.trim() || "未命名节点"]));
    const mindMapLinks = boardLinks
      .map((link) => {
        const from = itemMap.get(link.from);
        const to = itemMap.get(link.to);
        return from && to ? `- ${from} -> ${to}` : "";
      })
      .filter(Boolean)
      .join("\n");
    return [
      "# 白板临时记录",
      textItems ? `## 文本\n${textItems}` : "",
      mindMapLinks ? `## 思维导图关系\n${mindMapLinks}` : "",
      imageItems ? `## 图片\n${imageItems}` : "",
      drawPoints.length ? `## 手绘轨迹\n已记录 ${drawPoints.length} 个手绘点。` : ""
    ].filter(Boolean).join("\n\n");
  };

  const saveToolToGenerated = async (tool: ToolId) => {
    if (tool === "draft") {
      const text = draftText.trim() || "# 临时文档\n\n";
      await createGeneratedFile(`临时文档-${shortTime(new Date().toISOString()).replace(":", "-")}.md`, text);
      setDraftText("");
      setStatusText("临时文档已保存，已新建空白页");
      return;
    }
    if (tool === "whiteboard") {
      await createGeneratedFile(`白板记录-${shortTime(new Date().toISOString()).replace(":", "-")}.md`, boardToMarkdown());
      setBoardItems([]);
      setBoardLinks([]);
      setDrawPoints([]);
      setStatusText("白板已保存，已新建空白页");
    }
  };

  const clearToolContent = (tool: ToolId) => {
    if (tool === "draft") setDraftText("");
    if (tool === "whiteboard") {
      setBoardItems([]);
      setBoardLinks([]);
      setDrawPoints([]);
    }
  };

  const promoteGeneratedFile = async (file: DiscuzFile) => {
    await promoteFileToPrimary(file, true);
  };

  const sendDiscussionInput = async () => {
    const text = discussionText.trim();
    if (!text) return;
    const finishTask = beginTask("发送讨论输入");
    setDiscussionText("");
    try {
      const response = await fetch("/api/discussion-inputs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        discussionInputs: payload.discussionInputs ?? current.discussionInputs,
        activities: payload.activities ?? current.activities
      }));
      saveMeetingMessage(text, "user").catch((err) => setError(err instanceof Error ? err.message : "Unable to save meeting record"));
      if (await handleSpokenConfirmation(text)) return;

      const session = realtimeSessionRef.current;
      if (session) {
        if (responseActiveRef.current) {
          session.interrupt();
          responseActiveRef.current = false;
          clearResponseWatchdog();
        }
        session.sendMessage(`用户文字输入：${compactText(text, 1200)}`);
      } else {
        setStatusText("Saved for next discussion");
      }
    } finally {
      finishTask();
    }
  };

  const confirmDiscussionTopic = async (title: string, options: { notifyRealtime?: boolean } = {}) => {
    const finishTask = options.notifyRealtime !== false ? beginUniqueTask("confirm-topic", "确认讨论主题") : null;
    const confirmedTitle = title.trim();
    let failed = false;
    try {
      if (!confirmedTitle) throw new Error("Missing discussion topic title.");
      const response = await fetch("/api/discussion-topic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: confirmedTitle })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        discussionTopic: payload.discussionTopic ?? current.discussionTopic,
        directions: payload.directions ?? current.directions,
        activities: payload.activities ?? current.activities
      }));
      setTopicProposal(null);
      topicProposalRef.current = null;
      setDirectionProposal(null);
      directionProposalRef.current = null;
      pendingDirectionsAfterTopicRef.current = null;
      setStatusText("等待补充基本情况");
      const session = realtimeSessionRef.current;
      recordConversationDiagnostic("topic_confirmed:awaiting_background", { title: confirmedTitle });
      if (options.notifyRealtime !== false && session) {
        if (responseActiveRef.current) {
          session.interrupt();
          responseActiveRef.current = false;
          clearResponseWatchdog();
        }
        session.sendMessage([
          `系统事件：用户已确认讨论主题《${confirmedTitle}》。`,
          "下一步只问用户基本情况、目标、限制和希望产出的形式。用户说不清时，再读取压缩材料概述背景。"
        ].join("\n\n"));
      }
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      finishTask?.(failed);
    }
  };

  const confirmDirectionProposal = async (directions: string[], options: { notifyRealtime?: boolean } = {}) => {
    const finishTask = options.notifyRealtime !== false ? beginUniqueTask("confirm-directions", "确认讨论方向") : null;
    let failed = false;
    try {
      const response = await fetch("/api/directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directions })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        directions: payload.directions ?? current.directions,
        notes: payload.notes ?? current.notes,
        activities: payload.activities ?? current.activities,
        topics: payload.topics ?? current.topics
      }));
      setDirectionProposal(null);
      directionProposalRef.current = null;
      setStatusText("讨论方向已确认");
      const confirmedDirections = (payload.directions ?? []).map((direction: DiscussionDirection, index: number) => (
        `${index + 1}. ${direction.completed ? "已完成" : "未完成"}｜${direction.text}`
      )).join("\n");
      const session = realtimeSessionRef.current;
      if (options.notifyRealtime !== false && session) {
        if (responseActiveRef.current) {
          session.interrupt();
          responseActiveRef.current = false;
          clearResponseWatchdog();
        }
        session.sendMessage([
          "系统事件：用户已点击确认讨论方向 todo。",
          `当前已确认讨论主题：${discussionTopicRef.current || "未命名主题"}`,
          confirmedDirections ? `当前讨论方向：\n${compactText(confirmedDirections, 600)}` : "当前没有讨论方向。",
          "请调用 prepare_discussion_workbench，然后一句话从第一条开始。"
        ].join("\n\n"));
      }
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      finishTask?.(failed);
    }
  };

  const handleSpokenConfirmation = async (text: string) => {
    if (!isAffirmativeConfirmation(text)) return false;
    const pendingTopic = topicProposalRef.current;
    if (pendingTopic?.title) {
      await confirmDiscussionTopic(pendingTopic.title);
      return true;
    }
    const pendingDirectionGeneration = pendingDirectionsAfterTopicRef.current;
    if (pendingDirectionGeneration?.awaitingPermission) {
      pendingDirectionsAfterTopicRef.current = { ...pendingDirectionGeneration, awaitingPermission: false };
      recordConversationDiagnostic("directions_after_topic:permission_confirmed", { title: pendingDirectionGeneration.title });
      requestDirectionsAfterConfirmedTopic();
      return true;
    }
    const pendingDirections = directionProposalRef.current?.directions ?? [];
    if (pendingDirections.length) {
      await confirmDirectionProposal(pendingDirections);
      return true;
    }
    return false;
  };

  const addDiscussionDirections = async (directions: string[]) => {
    const response = await fetch("/api/directions/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directions })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setState((current) => ({
      ...current,
      directions: payload.directions ?? current.directions,
      notes: payload.notes ?? current.notes,
      activities: payload.activities ?? current.activities,
      topics: payload.topics ?? current.topics
    }));
    setStatusText("已追加讨论方向");
  };

  const completeDirection = async (direction: DiscussionDirection, note = "", options: { notifyRealtime?: boolean } = {}) => {
    const finishTask = options.notifyRealtime !== false ? beginUniqueTask("complete-direction", "完成讨论方向") : null;
    let failed = false;
    try {
      const response = await fetch(`/api/directions/${encodeURIComponent(direction.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        directions: payload.directions ?? current.directions,
        notes: payload.notes ?? current.notes,
        activities: payload.activities ?? current.activities,
        topics: payload.topics ?? current.topics
      }));
      const updatedDirections = (payload.directions ?? directionsRef.current) as DiscussionDirection[];
      const directionLines = updatedDirections.map((item, index) => `${index + 1}. ${item.completed ? "已完成" : "未完成"}｜${item.text}`).join("\n");
      if (options.notifyRealtime !== false && realtimeSessionRef.current) {
        if (responseActiveRef.current) {
          realtimeSessionRef.current.interrupt();
          responseActiveRef.current = false;
          clearResponseWatchdog();
        }
        realtimeSessionRef.current.sendMessage([
          `系统事件：用户已将讨论方向标记为完成：${direction.text}`,
          directionLines ? `当前讨论方向与完成状态：\n${directionLines}` : "当前没有讨论方向。",
          "请承接这个状态，只用一句自然短句确认进度，并建议继续下一个未完成方向。"
        ].join("\n\n"));
      }
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      finishTask?.(failed);
    }
  };

  const deleteDirection = async (direction: DiscussionDirection) => {
    const response = await fetch(`/api/directions/${encodeURIComponent(direction.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setState((current) => ({
      ...current,
      directions: payload.directions ?? current.directions,
      activities: payload.activities ?? current.activities,
      topics: payload.topics ?? current.topics
    }));
  };

  const cancelCurrentTask = useCallback(() => {
    realtimeSessionRef.current?.interrupt();
    responseActiveRef.current = false;
    responsePendingRef.current = false;
    finishAllVisibleTasks();
    setToolActivities((items) => items.map((item) => item.status === "running" ? { ...item, status: "cancelled", endedAt: new Date().toISOString(), result: "用户取消" } : item));
    setStatusText("已取消当前任务");
  }, [finishAllVisibleTasks]);

  const executeRealtimeTool = async (name: string, args: Record<string, any> = {}) => {
    const label = toolCallLabel(name);
    const activityId = createToolActivity(label, name);
    const finishTask = beginTask(label);
    let output = {};
    try {
      if (name === "search_context") {
        const response = await fetch(`/api/context/search?q=${encodeURIComponent(args.query || "")}`);
        output = await response.json();
      }
      if (name === "web_search") {
        if (!webEnabled) output = { error: "Web search is disabled by the user." };
        else if (shouldUseBackgroundResearch(args)) {
          const prompt = String(args.query || "").trim();
          const postActions = researchPostActions(args);
          const task = await queueBackgroundTask({
            kind: "web_search",
            title: compactText(String(args.title || prompt || "联网研究").trim(), 80),
            prompt,
            outputMode: "file",
            postActions
          });
          output = {
            ok: true,
            route: "background",
            queued: task?.title || prompt || "联网研究",
            taskId: task?.id,
            status: task?.status || "queued",
            postActions,
            next: postActions.includes("open_preview")
              ? "这类请求会产生较多搜索结果，已转入后台整理；完成后会加入主题区并打开。"
              : "这类请求会产生较多搜索结果，已转入后台整理。"
          };
        }
        else {
          const query = encodeURIComponent(args.query || "");
          const limit = args.limit ? `&limit=${encodeURIComponent(args.limit)}` : "";
          const response = await fetch(`/api/web/search?q=${query}${limit}`);
          output = await response.json();
        }
      }
      if (name === "research_request") {
        if (!webEnabled) output = { error: "Web search is disabled by the user." };
        else if (shouldUseBackgroundResearch(args)) {
          const queryText = String(args.query || "").trim();
          const title = compactText(String(args.title || queryText || "联网研究").trim(), 80);
          const postActions = researchPostActions(args);
          const task = await queueBackgroundTask({
            kind: "web_search",
            title,
            prompt: [
              queryText,
              args.purpose ? `用途：${String(args.purpose).trim()}` : "",
              args.output ? `期望输出：${String(args.output).trim()}` : ""
            ].filter(Boolean).join("\n"),
            outputMode: "file",
            postActions
          });
          output = {
            ok: true,
            route: "background",
            reason: "任务需要整理较多联网结果或生成可查看成果，已避免把大结果塞入实时语音上下文。",
            queued: task?.title || title,
            taskId: task?.id,
            status: task?.status || "queued",
            postActions,
            next: postActions.includes("open_preview")
              ? "完成后会按要求加入主题区并打开预览。"
              : "完成后会生成 AI 临时文件。"
          };
        } else {
          const query = encodeURIComponent(args.query || "");
          const limitValue = args.expectedItems ? Math.min(8, Math.max(1, Number(args.expectedItems))) : 6;
          const response = await fetch(`/api/web/search?q=${query}&limit=${encodeURIComponent(limitValue)}`);
          output = { ...(await response.json()), route: "direct" };
        }
      }
      if (name === "read_web_page") {
        if (!webEnabled) output = { error: "Web reading is disabled by the user." };
        else {
          const rawUrl = String(args.url || "").trim();
          const maxChars = args.maxChars ? `&maxChars=${encodeURIComponent(args.maxChars)}` : "";
          const response = await fetch(`/api/web/read?url=${encodeURIComponent(rawUrl)}${maxChars}`);
          output = await response.json();
        }
      }
      if (name === "open_web_page") {
        const parsed = parseHttpUrl(String(args.url || ""));
        if (parsed) {
          setWebPreview({ url: parsed.toString(), title: String(args.title || parsed.hostname || "网页").trim() });
          setActiveTool(null);
          setPreviewFileId(null);
          setPreviewRecordId(null);
          setGeneratedEditorId(null);
          output = { ok: true, opened: parsed.toString() };
        } else {
          output = { ok: false, error: "Invalid web URL. Use an http or https URL." };
        }
      }
      if (name === "import_url_as_topic_file") {
        const parsed = parseHttpUrl(String(args.url || ""));
        if (parsed) {
          const response = await fetch("/api/files/primary/url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: parsed.toString(), title: String(args.title || "") })
          });
          output = await response.json();
          if (!response.ok) {
            output = { ok: false, error: (output as { error?: string }).error || "Unable to import URL file." };
          } else {
            const payload = output as { file?: DiscuzFile; files?: DiscuzFile[]; activities?: AppState["activities"]; topics?: DiscussionTopic[] };
            setState((current) => ({
              ...current,
              files: payload.files ?? current.files,
              activities: payload.activities ?? current.activities,
              topics: payload.topics ?? current.topics
            }));
            if (payload.file?.id) {
              setSelectedId(payload.file.id);
              showPendingExtractionStatus([payload.file]);
              notifyPrimaryFilesAdded([payload.file]);
            }
          }
        } else {
          output = { ok: false, error: "Invalid web URL. Use an http or https URL." };
        }
      }
      if (name === "set_layout") {
        applyLayoutCommand(args.target || "reset", args.mode || "reset");
        output = { ok: true, layout: args };
      }
      if (name === "open_discussion_tool") {
        const tool = (args.tool || "whiteboard") as ToolId;
        openToolDiscussionWindow(tool);
        output = { ok: true, opened: args.tool };
      }
      if (name === "save_discussion_tool") {
        const tool = (args.tool === "whiteboard" || args.tool === "draft" ? args.tool : activeTool) as ToolId | null;
        if (tool === "whiteboard" || tool === "draft") {
          await saveToolToGenerated(tool);
          output = { ok: true, saved: tool };
        } else {
          output = { ok: false, error: "No savable tool is open." };
        }
      }
      if (name === "clear_discussion_tool") {
        const tool = (args.tool === "whiteboard" || args.tool === "draft" ? args.tool : activeTool) as ToolId | null;
        if (tool === "whiteboard" || tool === "draft") {
          clearToolContent(tool);
          output = { ok: true, cleared: tool };
        } else {
          output = { ok: false, error: "No clearable tool is open." };
        }
      }
      if (name === "close_foreground_window") {
        const target = String(args.target || "all");
        if (target === "tool" || target === "all") setActiveTool(null);
        if (target === "web" || target === "all") setWebPreview(null);
        if (target === "file" || target === "all") {
          setPreviewFileId(null);
          setGeneratedEditorId(null);
        }
        if (target === "record" || target === "all") setPreviewRecordId(null);
        output = { ok: true, closed: target };
      }
      if (name === "open_file_preview") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role : undefined;
        const queryText = String(args.query || "").trim().toLowerCase();
        const candidate = state.files.find((file) => {
          const roleMatches = !role || file.role === role;
          const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
          return roleMatches && nameMatches;
        }) ?? state.files.find((file) => !role || file.role === role);
        if (candidate) {
          openFileDiscussionWindow(candidate);
          output = { ok: true, opened: candidate.originalName };
        } else {
          output = { ok: false, error: "No matching file found." };
        }
      }
      if (name === "analyze_word_file" || name === "analyze_spreadsheet_file" || name === "analyze_presentation_file") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : undefined;
        const queryText = String(args.query || "").trim();
        const focus = String(args.focus || "").trim();
        const analysisKind: OfficeAnalysisKind =
          name === "analyze_word_file" ? "word" :
            name === "analyze_spreadsheet_file" ? "spreadsheet" :
              "presentation";
        const candidate = selectOfficeFile(state.files, analysisKind, role, queryText);
        if (!candidate) {
          output = {
            ok: false,
            error: `No matching ${analysisKind} file found. Ask the user to upload one or specify the filename.`
          };
        } else if (shouldQueueFileAnalysis(candidate, focus, analysisKind)) {
          const postActions = fileAnalysisPostActions(focus);
          const task = await queueBackgroundTask({
            kind: "file_analysis",
            title: compactText(`${candidate.originalName} 分析`, 80),
            prompt: [
              `请分析文件：${candidate.originalName}`,
              focus ? `分析重点：${focus}` : "分析重点：根据文件内容整理结论、依据、风险和下一步。",
              "如果用户要求报告、表格、清单、完整分析或打开预览，请生成结构化 Markdown 成果。"
            ].join("\n"),
            outputMode: "file",
            targetFileIds: [candidate.id],
            postActions
          });
          output = {
            ok: true,
            route: "background",
            reason: "该文件分析可能产生较长上下文，已转入后台生成结果文件。",
            queued: task?.title || `${candidate.originalName} 分析`,
            taskId: task?.id,
            status: task?.status || "queued",
            postActions,
            next: postActions.includes("open_preview")
              ? "完成后会按要求加入主题区或打开预览。"
              : "完成后会在 AI 临时文件区生成分析结果。"
          };
        } else if (analysisKind === "word") {
          output = buildWordAnalysisPayload(candidate, focus);
        } else if (analysisKind === "spreadsheet") {
          output = buildSpreadsheetAnalysisPayload(candidate, focus);
        } else {
          output = buildPresentationAnalysisPayload(candidate, focus);
        }
      }
      if (name === "analyze_image_file") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : undefined;
        const candidate = selectFileByQuery(state.files, String(args.query || ""), role, ["image"]);
        if (!candidate) {
          output = { ok: false, error: "No matching image file found. Ask the user to upload or specify an image." };
        } else {
          const response = await fetch(`/api/files/${encodeURIComponent(candidate.id)}/analyze-image`, { method: "POST" });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Image analysis failed");
          setState((current) => ({
            ...current,
            files: payload.files ?? current.files,
            activities: payload.activities ?? current.activities
          }));
          output = {
            ok: true,
            file: fileBrief(payload.file ?? candidate),
            focus: String(args.focus || "").trim(),
            analysis: compactText(payload.file?.extractedText || candidate.extractedText || candidate.summary || "", 1200)
          };
        }
      }
      if (name === "read_current_focus") {
        output = {
          ok: true,
          activeTool,
          foreground: {
            tool: activeTool,
            file: previewFile ? fileBrief(previewFile) : null,
            record: previewRecord ? { id: previewRecord.id, title: previewRecord.title, noteCount: previewRecord.noteCount } : null,
            generatedEditor: generatedEditorFile ? fileBrief(generatedEditorFile) : null,
            web: webPreview
          },
          selectedFile: selectedFile ? fileBrief(selectedFile) : null,
          topic: state.discussionTopic || state.topics.find((topic) => topic.active)?.title || ""
        };
      }
      if (name === "get_discussion_state") {
        output = {
          ok: true,
          topic: state.discussionTopic,
          activeTopicId: state.activeTopicId,
          files: state.files.map(fileBrief),
          directions: state.directions.slice(-8).map((direction) => ({ ...direction, text: compactText(direction.text, 160) })),
          notes: state.notes.slice(-8).map((note) => ({ ...note, text: compactText(note.text, 180) })),
          meetingMessages: state.meetingMessages.slice(-8).map((message) => ({ ...message, text: compactText(message.text, 180) })),
          records: state.records.slice(-3).map((record) => ({ id: record.id, title: record.title, noteCount: record.noteCount, startedAt: record.startedAt, endedAt: record.endedAt })),
          pendingTasks: pendingTasks.map((task) => ({ id: task.id, label: task.label })),
          backgroundTasks: (state.backgroundTasks ?? []).slice(0, 8).map((task) => ({
            id: task.id,
            title: compactText(task.title, 100),
            kind: task.kind,
            status: task.status,
            resultFile: task.resultFile ? { id: task.resultFile.id, name: task.resultFile.name } : null,
            postActions: task.postActions ?? [],
            error: compactText(task.error || "", 160)
          })),
          statusText,
          foreground: { activeTool, previewFile: previewFile ? fileBrief(previewFile) : null, webPreview },
          governance: {
            discussionContract: discussionContract ? {
              goal: compactText(discussionContract.goal, 160),
              outputFormat: compactText(discussionContract.outputFormat, 120),
              responseLength: discussionContract.responseLength
            } : null,
            discussionAgenda: discussionAgenda.slice(0, 6).map((item) => ({
              title: compactText(item.title, 100),
              status: item.status
            })),
            agendaLocked,
            currentAgendaIndex,
            responseScope,
            userCognitiveLoad,
            outputRubric: outputRubric.slice(0, 5).map((item) => compactText(item, 100))
          }
        };
      }
      if (name === "ask_user_confirmation") {
        const prompt = String(args.prompt || "").trim();
        const options = normalizeLines(args.options).slice(0, 4);
        setStatusText(prompt ? `等待用户确认：${prompt}` : "等待用户确认");
        output = { ok: true, needsConfirmation: true, prompt, options };
      }
      if (name === "queue_task") {
        const title = String(args.title || "待处理任务").trim();
        const detail = String(args.detail || "").trim();
        setStatusLog((items) => [...items, {
          id: crypto.randomUUID(),
          kind: "status",
          text: `已加入待办：${title}${detail ? `｜${detail}` : ""}`,
          createdAt: new Date().toISOString()
        }]);
        output = { ok: true, queued: title, detail };
      }
      if (name === "run_background_task") {
        const kind = ["generic", "file_analysis", "web_search", "report", "code"].includes(args.kind) ? args.kind : "generic";
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : undefined;
        const queryText = String(args.query || "").trim().toLowerCase();
        const targetFileIds = state.files
          .filter((file) => {
            const roleMatches = !role || file.role === role;
            const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
            return roleMatches && nameMatches;
          })
          .slice(0, 8)
          .map((file) => file.id);
        const postActions = Array.isArray(args.postActions)
          ? args.postActions.filter((item: unknown) => item === "add_to_topic" || item === "open_preview")
          : researchPostActions(args);
        const task = await queueBackgroundTask({
          kind,
          title: compactText(String(args.title || "后台任务").trim(), 80),
          prompt: compactText(String(args.prompt || "").trim(), 1200),
          outputMode: args.output === "summary" || args.output === "both" ? args.output : "file",
          targetFileIds,
          postActions
        });
        output = {
          ok: true,
          route: "background",
          queued: task?.title || args.title || "后台任务",
          taskId: task?.id,
          status: task?.status || "queued",
          postActions,
          next: postActions.includes("open_preview")
            ? "后台任务已排队。完成后会生成结果文件，并按要求打开。"
            : "后台任务已排队。完成后会在 AI 临时文件区生成结果文件。"
        };
      }
      if (name === "start_break") {
        const minutes = Math.max(1, Math.min(30, Number(args.minutes || args.durationMinutes || 5)));
        const untilDate = new Date();
        untilDate.setTime(untilDate.getTime() + minutes * 60000);
        const until = untilDate.toISOString();
        setBreakUntil(until);
        const nextAmbient = args.ambientMode === true ? true : ambientMode;
        setAmbientMode(nextAmbient);
        if (nextAmbient) setWebPreview((current) => current ?? ambientMusicPreview());
        setStatusText(`休息中 ${minutes}:00`);
        output = { ok: true, breakUntil: until, minutes };
      }
      if (name === "resume_discussion") {
        setBreakUntil(null);
        setAmbientMode(false);
        setWebPreview((current) => isAmbientPreview(current) ? null : current);
        setStatusText("已回到讨论");
        output = { ok: true, resumed: true };
      }
      if (name === "open_media_url") {
        const parsed = parseHttpUrl(String(args.url || ""));
        if (parsed) {
          const mediaType = String(args.mediaType || "media").trim();
          setWebPreview({ url: parsed.toString(), title: String(args.title || (mediaType === "music" ? "在线音乐" : mediaType === "video" ? "视频" : "媒体")).trim() });
          setStatusText("媒体窗口已打开");
          output = { ok: true, opened: parsed.toString(), mediaType };
        } else {
          output = { ok: false, error: "Invalid media URL. Use an http or https URL." };
        }
      }
      if (name === "set_ambient_mode") {
        const enabled = args.enabled !== false;
        setAmbientMode(enabled);
        const musicUrl = String(args.musicUrl || "").trim();
        if (enabled && musicUrl) {
          const parsed = parseHttpUrl(musicUrl);
          if (parsed) setWebPreview({ url: parsed.toString(), title: String(args.title || "氛围音乐").trim() });
        }
        if (enabled && !musicUrl) setWebPreview(ambientMusicPreview());
        if (!enabled) setWebPreview((current) => isAmbientPreview(current) ? null : current);
        setStatusText(enabled ? "氛围模式已开启，轻音乐已打开" : "氛围模式已关闭");
        output = { ok: true, ambientMode: enabled, musicUrl: musicUrl || "/ambient.html" };
      }
      if (name === "show_tool_activity") {
        output = { ok: true, activities: toolActivities.slice(0, 8) };
      }
      if (name === "cancel_current_task") {
        cancelCurrentTask();
        output = { ok: true, cancelled: true };
      }
      if (name === "edit_spreadsheet_file") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : "generated";
        const candidate = selectFileByQuery(state.files, String(args.query || ""), role, ["spreadsheet"]);
        const editPlan = String(args.editPlan || args.instructions || "").trim();
        if (!candidate) {
          output = { ok: false, error: "No matching spreadsheet file found in the requested area." };
        } else if (!editPlan) {
          output = { ok: false, error: "Missing spreadsheet edit plan." };
        } else {
          const file = await createGeneratedFile(
            `表格修改方案-${candidate.originalName}.md`,
            [
              `# 表格修改方案：${candidate.originalName}`,
              `目标文件：${candidate.originalName}`,
              `安全说明：当前工具先生成可审核的修改方案，不直接覆盖原 Excel。`,
              "",
              "## 修改要求",
              editPlan,
              "",
              "## 原表格摘录",
              compactText(candidate.extractedText || candidate.summary || "", 3000)
            ].join("\n")
          );
          output = { ok: true, generated: file.originalName, sourceFile: fileBrief(candidate) };
        }
      }
      if (name === "create_outline") {
        const title = String(args.title || "讨论大纲.md").trim();
        const sections = normalizeLines(args.sections);
        const text = String(args.text || "").trim() || sections.map((section, index) => `${index + 1}. ${section}`).join("\n");
        if (!text) output = { ok: false, error: "Missing outline content." };
        else {
          const file = await createGeneratedFile(title, `# ${title.replace(/\.md$/i, "")}\n\n${text}`);
          output = { ok: true, generated: file.originalName };
        }
      }
      if (name === "compare_files") {
        const firstRole = args.firstRole === "primary" || args.firstRole === "context" || args.firstRole === "generated" ? args.firstRole as DiscuzFile["role"] : undefined;
        const secondRole = args.secondRole === "primary" || args.secondRole === "context" || args.secondRole === "generated" ? args.secondRole as DiscuzFile["role"] : undefined;
        const first = selectFileByQuery(state.files, String(args.firstQuery || ""), firstRole, undefined);
        const second = selectFileByQuery(state.files, String(args.secondQuery || ""), secondRole, undefined);
        if (!first || !second) {
          output = { ok: false, error: "Need two matching files to compare." };
        } else if (shouldQueueFileAnalysis(first, "比较文件", second.extractedText || second.summary || "") || shouldQueueFileAnalysis(second, "比较文件", first.extractedText || first.summary || "")) {
          const task = await queueBackgroundTask({
            kind: "file_analysis",
            title: compactText(`文件对比-${first.originalName}-${second.originalName}`, 80),
            prompt: [
              `请对比两个文件：${first.originalName} 与 ${second.originalName}`,
              "输出结构化 Markdown：核心差异、共同点、冲突/风险、可引用依据、建议下一步。",
              "不要只给摘要；如果材料不足，明确说明缺口。"
            ].join("\n"),
            outputMode: "file",
            targetFileIds: [first.id, second.id]
          });
          output = {
            ok: true,
            route: "background",
            reason: "文件对比会产生较长上下文，已转入后台生成对比文件。",
            queued: task?.title || "文件对比",
            taskId: task?.id,
            status: task?.status || "queued",
            next: "完成后会在 AI 临时文件区生成对比结果。"
          };
        } else {
          output = {
            ok: true,
            files: [fileBrief(first), fileBrief(second)],
            firstContent: compactText(first.extractedText || first.summary || "", 3000),
            secondContent: compactText(second.extractedText || second.summary || "", 3000),
            instruction: "Compare these two files and summarize differences, risks, and suggested next edits."
          };
        }
      }
      if (name === "extract_action_items") {
        const items = (Array.isArray(args.items) ? args.items : []).map((item: unknown) => {
          const value = item as { task?: unknown; owner?: unknown; due?: unknown };
          return [String(value.task || "").trim(), String(value.owner || "").trim(), String(value.due || "").trim()];
        }).filter((row: string[]) => row[0]);
        const source = String(args.source || "会议记录").trim();
        if (!items.length) output = { ok: false, error: "Missing action items." };
        else {
          const file = await createGeneratedFile(`行动项-${shortTime(new Date().toISOString()).replace(":", "-")}.md`, [
            `# 行动项`,
            `来源：${source}`,
            "",
            markdownTable(["任务", "负责人", "截止时间"], items)
          ].join("\n"));
          output = { ok: true, generated: file.originalName, count: items.length };
        }
      }
      if (name === "create_table_summary") {
        const headers = normalizeLines(args.headers).slice(0, 8);
        const rows = (Array.isArray(args.rows) ? args.rows : []).map((row: unknown) => Array.isArray(row) ? row.map((cell) => String(cell || "")) : []);
        const title = String(args.title || "讨论表格总结.md").trim();
        if (!headers.length || !rows.length) output = { ok: false, error: "Missing table headers or rows." };
        else {
          const file = await createGeneratedFile(title, `# ${title.replace(/\.md$/i, "")}\n\n${markdownTable(headers, rows)}`);
          output = { ok: true, generated: file.originalName, rows: rows.length };
        }
      }
      if (name === "export_discussion_record") {
        const title = String(args.title || `讨论记录-${shortTime(new Date().toISOString()).replace(":", "-")}.md`).trim();
        const file = await createGeneratedFile(title, buildDiscussionRecordMarkdown(title));
        output = { ok: true, generated: file.originalName };
      }
      if (name === "download_file") {
        const target = ["selected_file", "foreground_file", "file", "meeting_record", "notes", "discussion_record"].includes(args.target) ? String(args.target) : "selected_file";
        const title = String(args.title || "").trim();
        if (target === "meeting_record") {
          downloadMarkdown(exportFileName(title || `${state.discussionTopic || "当前讨论"}-会议记录`), buildMeetingRecordMarkdown());
          setStatusText("会议记录已下载");
          output = { ok: true, downloaded: "meeting_record" };
        } else if (target === "notes") {
          downloadMarkdown(exportFileName(title || `${state.discussionTopic || "当前讨论"}-要点`), buildNotesMarkdown());
          setStatusText("要点已下载");
          output = { ok: true, downloaded: "notes" };
        } else if (target === "discussion_record") {
          const filename = title || `${state.discussionTopic || "当前讨论"}-讨论记录`;
          downloadMarkdown(exportFileName(filename), buildDiscussionRecordMarkdown(filename));
          setStatusText("讨论记录已下载");
          output = { ok: true, downloaded: "discussion_record" };
        } else {
          const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : undefined;
          const queryText = String(args.query || "").trim();
          const candidate =
            target === "foreground_file" ? generatedEditorFile ?? previewFile :
              target === "file" ? selectFileByQuery(state.files, queryText, role, undefined) :
                selectedFile;
          if (!candidate) {
            output = { ok: false, error: "No matching file found to download." };
          } else {
            downloadUploadedFile(candidate);
            setStatusText("文件已下载");
            output = { ok: true, downloaded: candidate.originalName, file: fileBrief(candidate) };
          }
        }
      }
      if (name === "create_diagram") {
        const title = String(args.title || "讨论图表.md").trim();
        const diagramType = String(args.diagramType || "mermaid").trim();
        const content = String(args.content || "").trim();
        if (!content) output = { ok: false, error: "Missing diagram content." };
        else {
          const fenced = diagramType === "mermaid" || content.startsWith("graph ") || content.startsWith("flowchart ")
            ? `\`\`\`mermaid\n${content}\n\`\`\``
            : content;
          const file = await createGeneratedFile(title, `# ${title.replace(/\.md$/i, "")}\n\n${fenced}`);
          output = { ok: true, generated: file.originalName, diagramType };
        }
      }
      if (name === "schedule_followup") {
        const title = String(args.title || "后续跟进").trim();
        const when = String(args.when || "").trim();
        const detail = String(args.detail || "").trim();
        await saveNote(`${title}${when ? `｜时间：${when}` : ""}${detail ? `｜${detail}` : ""}`, "action", "AI follow-up");
        output = { ok: true, scheduled: title, when, detail, noteSaved: true };
      }
      if (name === "set_discussion_contract") {
        const goal = String(args.goal || "").trim();
        const boundaries = normalizeLines(args.boundaries).slice(0, 8);
        const outputFormat = String(args.outputFormat || "阶段性结论 + 下一步").trim();
        const responseLength = ["short", "medium", "long"].includes(args.responseLength) ? args.responseLength as DiscussionContract["responseLength"] : "short";
        if (!goal) output = { ok: false, error: "Missing discussion goal." };
        else {
          const contract = { goal, boundaries, outputFormat, responseLength, updatedAt: new Date().toISOString() };
          setDiscussionContract(contract);
          setResponseScope((scope) => ({ ...scope, maxSentences: responseLength === "long" ? 6 : responseLength === "medium" ? 4 : 2 }));
          await saveNote(`讨论契约：目标是“${goal}”；边界：${boundaries.join("、") || "暂无"}；输出形式：${outputFormat}`, "point", "Discussion contract");
          output = { ok: true, contract };
        }
      }
      if (name === "check_topic_alignment") {
        const aligned = args.aligned !== false;
        const score = Math.max(0, Math.min(100, Number(args.score ?? (aligned ? 90 : 45))));
        const issue = String(args.issue || "").trim();
        const recommendation = String(args.recommendation || "").trim();
        if (!aligned || score < 70) setStatusText(`主题偏离提醒：${recommendation || issue || "请回到当前主题"}`);
        output = { ok: true, aligned, score, issue, recommendation, topic: state.discussionTopic };
      }
      if (name === "advance_discussion_step") {
        const nextIndex = Number.isFinite(Number(args.stepIndex)) ? Number(args.stepIndex) : currentAgendaIndex + 1;
        const note = String(args.note || "").trim();
        setCurrentAgendaIndex(Math.max(0, nextIndex));
        setDiscussionAgenda((items) => items.map((item, index) => ({
          ...item,
          status: index < nextIndex ? "done" : index === nextIndex ? "active" : "pending"
        })));
        if (note) await saveNote(note, "point", "Discussion step");
        output = { ok: true, currentAgendaIndex: Math.max(0, nextIndex), note };
      }
      if (name === "mark_uncertainty") {
        const text = String(args.text || "").trim();
        const reason = String(args.reason || "").trim();
        const needed = normalizeLines(args.needed).slice(0, 5);
        if (!text) output = { ok: false, error: "Missing uncertainty text." };
        else {
          await saveNote(`不确定：${text}${reason ? `；原因：${reason}` : ""}${needed.length ? `；需要补充：${needed.join("、")}` : ""}`, "question", "Uncertainty");
          output = { ok: true, text, reason, needed };
        }
      }
      if (name === "limit_response_scope") {
        const maxSentences = Math.max(1, Math.min(8, Number(args.maxSentences || 2)));
        const onePointOnly = args.onePointOnly !== false;
        const mustAskFirst = args.mustAskFirst === true;
        const scope = { maxSentences, onePointOnly, mustAskFirst };
        setResponseScope(scope);
        output = { ok: true, scope };
      }
      if (name === "create_discussion_agenda") {
        const items = (Array.isArray(args.items) ? args.items : []).map((item: unknown) => {
          const value = item as { title?: unknown; objective?: unknown; output?: unknown };
          return {
            title: String(value.title || "").trim(),
            objective: String(value.objective || "").trim(),
            output: String(value.output || "").trim(),
            status: "pending" as const
          };
        }).filter((item: DiscussionAgendaItem) => item.title).slice(0, 8);
        if (!items.length) output = { ok: false, error: "Missing agenda items." };
        else {
          const agenda = items.map((item: DiscussionAgendaItem, index: number) => ({ ...item, status: index === 0 ? "active" as const : "pending" as const }));
          setDiscussionAgenda(agenda);
          setCurrentAgendaIndex(0);
          setAgendaLocked(false);
          output = { ok: true, agenda, locked: false };
        }
      }
      if (name === "lock_discussion_agenda") {
        setAgendaLocked(true);
        const reason = String(args.reason || "").trim();
        await saveNote(`讨论议程已锁定${reason ? `：${reason}` : "。"}`, "decision", "Agenda");
        output = { ok: true, locked: true, agenda: discussionAgenda };
      }
      if (name === "request_agenda_change") {
        const change = String(args.change || "").trim();
        const reason = String(args.reason || "").trim();
        setStatusText(change ? `等待议程变更确认：${change}` : "等待议程变更确认");
        output = { ok: true, needsConfirmation: true, change, reason, locked: agendaLocked };
      }
      if (name === "score_discussion_progress") {
        const score = Math.max(0, Math.min(100, Number(args.score || 0)));
        const completed = normalizeLines(args.completed).slice(0, 8);
        const blocked = normalizeLines(args.blocked).slice(0, 8);
        const next = normalizeLines(args.next).slice(0, 8);
        output = { ok: true, score, completed, blocked, next };
      }
      if (name === "summarize_current_step") {
        const summary = String(args.summary || "").trim();
        const next = String(args.next || "").trim();
        if (!summary) output = { ok: false, error: "Missing step summary." };
        else {
          await saveNote(`${summary}${next ? ` 下一步：${next}` : ""}`, "point", "Step summary");
          output = { ok: true, summary, next };
        }
      }
      if (name === "detect_overlong_answer") {
        const original = String(args.original || "").trim();
        const compressed = String(args.compressed || "").trim();
        const maxSentences = Math.max(1, Math.min(8, Number(args.maxSentences || responseScope.maxSentences)));
        output = {
          ok: true,
          overlong: original ? original.split(/[。！？!?]/).filter(Boolean).length > maxSentences : false,
          maxSentences,
          compressed
        };
      }
      if (name === "set_user_cognitive_load") {
        const level = ["simple", "normal", "detailed", "step_by_step"].includes(args.level) ? args.level as CognitiveLoad : "step_by_step";
        setUserCognitiveLoad(level);
        if (level === "simple" || level === "step_by_step") setResponseScope((scope) => ({ ...scope, maxSentences: 2, onePointOnly: true }));
        output = { ok: true, level };
      }
      if (name === "pause_and_wait") {
        const reason = String(args.reason || "等待用户继续").trim();
        setStatusText(reason);
        output = { ok: true, paused: true, reason };
      }
      if (name === "define_output_rubric") {
        const criteria = normalizeLines(args.criteria).slice(0, 10);
        if (!criteria.length) output = { ok: false, error: "Missing rubric criteria." };
        else {
          setOutputRubric(criteria);
          const file = await createGeneratedFile("产出评价标准.md", `# 产出评价标准\n\n${criteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}`);
          output = { ok: true, criteria, generated: file.originalName };
        }
      }
      if (name === "save_discussion_note") {
        const kind = ["point", "decision", "question", "action"].includes(args.kind) ? args.kind as Note["kind"] : "point";
        const text = compactText(String(args.text || "").trim(), 500);
        if (text) {
          await saveNote(text, kind, "AI summary");
          output = { ok: true, saved: text };
        } else {
          output = { ok: false, error: "Missing note text." };
        }
      }
      if (name === "create_generated_file") {
        const title = String(args.title || "AI临时文案.md").trim();
        const text = compactText(String(args.text || "").trim(), 3000);
        if (text) {
          const file = await createGeneratedFile(title, text);
          output = { ok: true, generated: file.originalName };
        } else {
          output = { ok: false, error: "Missing generated file text." };
        }
      }
      if (name === "prepare_discussion_workbench") {
        const rawTopic = state.discussionTopic || state.topics.find((topicItem) => topicItem.active)?.title || "讨论";
        const safeTopic = rawTopic.replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 24) || "讨论";
        const file = await createGeneratedFile(`${safeTopic}-讨论工作台.md`, buildDiscussionWorkbenchMarkdown());
        setGeneratedEditorId(file.id);
        setWebPreview(null);
        output = {
          ok: true,
          prepared: "discussion_workbench",
          generated: file.originalName,
          next: "从第一条未完成方向开始，一次只讨论一个问题。"
        };
      }
      if (name === "generate_image") {
        const title = String(args.title || "AI生成图片.png").trim();
        const prompt = compactText(String(args.prompt || "").trim(), 1200);
        const size = ["1024x1024", "1024x1536", "1536x1024"].includes(args.size) ? args.size : "1024x1024";
        const quality = ["low", "medium", "high", "auto"].includes(args.quality) ? args.quality : "high";
        if (prompt) {
          const file = await generateImageFile(title, prompt, size, quality);
          output = { ok: true, generated: file.originalName, opened: file.originalName };
        } else {
          output = { ok: false, error: "Missing image prompt." };
        }
      }
      if (name === "copy_file_to_generated") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role : undefined;
        const queryText = String(args.query || "").trim().toLowerCase();
        const candidate = state.files.find((file) => {
          const roleMatches = !role || file.role === role;
          const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
          return roleMatches && nameMatches;
        });
        if (candidate) {
          const file = await copyFileToGenerated(candidate);
          output = { ok: true, copied: file.originalName };
        } else {
          output = { ok: false, error: "No matching file found to copy." };
        }
      }
      if (name === "add_file_to_topic") {
        const queryText = String(args.query || "").trim().toLowerCase();
        const candidates = state.files.filter((file) => file.role === "context" || file.role === "generated");
        const file = (queryText
          ? candidates.find((candidate) => candidate.originalName.toLowerCase().includes(queryText))
          : candidates.length === 1 ? candidates[0] : undefined);
        if (file) {
          await promoteFileToPrimary(file);
          output = { ok: true, added: file.originalName };
        } else {
          output = { ok: false, error: "No matching resource or AI generated file found." };
        }
      }
      if (name === "move_file_to_area") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : undefined;
        const queryText = String(args.query || "").trim().toLowerCase();
        const candidate = state.files.find((file) => {
          const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
          return nameMatches;
        });
        if (candidate && role) {
          if (role === "generated" && candidate.role !== "generated") {
            const file = await copyFileToGenerated(candidate);
            output = { ok: true, copied: file.originalName, target: role };
          } else {
            await moveFileToRole(candidate, role);
            output = { ok: true, moved: candidate.originalName, target: role };
          }
        } else {
          output = { ok: false, error: "No matching file or target area found." };
        }
      }
      if (name === "update_generated_file") {
        const queryText = String(args.query || "").trim().toLowerCase();
        const text = compactText(String(args.text || "").trim(), 3000);
        const candidate = state.files.find((file) => {
          const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
          return file.role === "generated" && nameMatches && (file.kind === "markdown" || file.kind === "text");
        });
        if (candidate && text) {
          await updateGeneratedFile(candidate, text);
          setGeneratedEditorId(candidate.id);
          setWebPreview(null);
          output = { ok: true, updated: candidate.originalName };
        } else {
          output = { ok: false, error: "No editable generated text file or replacement text found." };
        }
      }
      if (name === "propose_discussion_directions") {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .map((item: unknown) => compactText(String(item || "").trim(), 120))
          .filter(Boolean)
          .slice(0, 3);
        if (directions.length) {
          const proposal = { directions, reason: String(args.reason || "").trim() };
          directionProposalRef.current = proposal;
          setDirectionProposal(proposal);
          finishPendingDirectionsAfterTopic();
          output = { ok: true, proposed: directions };
        } else {
          output = { ok: false, error: "Missing discussion directions." };
        }
      }
      if (name === "prepare_discussion_directions") {
        const response = await fetch("/api/ai/discussion/directions", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to prepare discussion directions.");
        const proposal = payload.proposal as DirectionProposal | undefined;
        const directions = (proposal?.directions ?? []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3);
        if (directions.length) {
          const nextProposal = { directions, reason: String(proposal?.reason || "后台已基于当前材料生成方向。").trim() };
          directionProposalRef.current = nextProposal;
          setDirectionProposal(nextProposal);
          finishPendingDirectionsAfterTopic();
          output = { ok: true, prepared: "discussion_directions", count: directions.length, directions };
        } else {
          output = { ok: false, error: "Background model returned no discussion directions." };
        }
      }
      if (name === "update_discussion_directions") {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .map((item: unknown) => compactText(String(item || "").trim(), 120))
          .filter(Boolean)
          .slice(0, 8);
        if (directions.length) {
          await confirmDirectionProposal(directions, { notifyRealtime: false });
          output = { ok: true, directions };
        } else {
          output = { ok: false, error: "Missing discussion directions." };
        }
      }
      if (name === "add_discussion_directions") {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .map((item: unknown) => compactText(String(item || "").trim(), 120))
          .filter(Boolean)
          .slice(0, 3);
        if (directions.length) {
          await addDiscussionDirections(directions);
          output = { ok: true, added: directions };
        } else {
          output = { ok: false, error: "Missing discussion directions to add." };
        }
      }
      if (name === "complete_discussion_direction") {
        const queryText = String(args.query || "").trim().toLowerCase();
        const candidate = state.directions.find((direction, index) => {
          return direction.id === queryText || String(index + 1) === queryText || direction.text.toLowerCase().includes(queryText);
        });
        if (candidate) {
          await completeDirection(candidate, compactText(String(args.note || "").trim(), 300), { notifyRealtime: false });
          output = { ok: true, completed: candidate.text };
        } else {
          output = { ok: false, error: "No matching discussion direction found." };
        }
      }
      if (name === "confirm_discussion_topic") {
        const title = String(args.title || topicProposalRef.current?.title || "").trim();
        if (title) {
          await confirmDiscussionTopic(title, { notifyRealtime: false });
          output = {
            ok: true,
            confirmed: title,
            next: "Briefly acknowledge the confirmed topic, then ask for the user's basic situation, goals, constraints, and desired output. If the user cannot add details, inspect the topic/resource files and summarize the background before proposing discussion directions."
          };
        } else {
          output = { ok: false, error: "No pending discussion topic to confirm." };
        }
      }
      if (name === "confirm_discussion_directions") {
        const directions = directionProposalRef.current?.directions ?? [];
        if (directions.length) {
          await confirmDirectionProposal(directions, { notifyRealtime: false });
          output = {
            ok: true,
            confirmed: directions,
            next: "Call prepare_discussion_workbench, then begin with the first confirmed direction."
          };
        } else {
          output = { ok: false, error: "No pending discussion directions to confirm." };
        }
      }
      if (name === "end_voice_discussion") {
        pendingVoiceStopAfterResponseRef.current = "awaiting_closing";
        setStatusText("正在结束讨论");
        output = {
          ok: true,
          ending: true,
          next: "Give one short Chinese closing response to the user. The app will disconnect voice after this response is done."
        };
      }
      if (name === "propose_discussion_topic") {
        const title = String(args.title || "").trim();
        const reason = String(args.reason || "").trim();
        const intent: TopicProposal["intent"] = args.intent === "drift" ? "drift" : "confirm";
        if (topicFileChangeBlocksTopicProposalRef.current) {
          setStatusText("已阻止自动修改主题");
          output = {
            ok: false,
            error: "刚刚发生主题区文件增删。此时只能询问用户下一步，不允许拟确认或修改讨论主题，除非用户明确要求。"
          };
        } else if (title) {
          const proposal = { title, reason, intent };
          topicProposalRef.current = proposal;
          setTopicProposal(proposal);
          output = { ok: true, proposed: title };
        } else {
          output = { ok: false, error: "Missing topic title." };
        }
      }
      if (name === "prepare_discussion_topic") {
        if (topicFileChangeBlocksTopicProposalRef.current) {
          setStatusText("已阻止自动修改主题");
          output = {
            ok: false,
            error: "刚刚发生主题区文件增删。此时只能询问用户下一步，不允许拟确认或修改讨论主题，除非用户明确要求。"
          };
        } else {
          const response = await fetch("/api/ai/discussion/topic", { method: "POST" });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Unable to prepare discussion topic.");
          const proposal = payload.proposal as TopicProposal | undefined;
          const title = String(proposal?.title || "").trim();
          if (title) {
            const nextProposal = {
              title,
              reason: String(proposal?.reason || "后台已基于当前材料生成主题。").trim(),
              intent: proposal?.intent === "drift" ? "drift" as const : "confirm" as const
            };
            topicProposalRef.current = nextProposal;
            setTopicProposal(nextProposal);
            output = { ok: true, prepared: "discussion_topic", title };
          } else {
            output = { ok: false, error: "Background model returned no discussion topic." };
          }
        }
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : "Tool call failed";
      setError(messageText);
      output = { ok: false, error: messageText };
    } finally {
      const failed = Boolean((output as { error?: unknown; ok?: unknown }).error) || (output as { ok?: unknown }).ok === false;
      updateToolActivity(activityId, {
        status: failed ? "failed" : "done",
        endedAt: new Date().toISOString(),
        result: summarizeToolResult(output)
      });
      finishTask(failed);
      scheduleResponseTask("AI整理结果");
    }
    return compactToolOutputForRealtime(name, output);
  };

  useEffect(() => {
    executeRealtimeToolRef.current = executeRealtimeTool;
  });

  const diagnosticSnapshot = useCallback((): DiagnosticSnapshot => ({
      statusText: statusTextRef.current,
      pendingTasks: pendingTasksRef.current,
      visibleTasks: visibleTasksRef.current,
      toolActivities: toolActivitiesRef.current.slice(0, 12),
      taskEvents: diagnosticEventsRef.current.slice(-60)
  }), []);

  const runDiagnosticTool = useCallback(async (name: string, args: Record<string, unknown> = {}) => {
    const startedAt = performance.now();
    const eventStartIndex = diagnosticEventsRef.current.length;
    const executor = executeRealtimeToolRef.current;
    if (!executor) throw new Error("Realtime tool executor is not ready.");
    const result = await executor(name, args);
    await new Promise((resolve) => window.setTimeout(resolve, 960));
    const taskEvents = diagnosticEventsRef.current.slice(eventStartIndex);
    const failed = Boolean((result as { error?: unknown; ok?: unknown })?.error) || (result as { ok?: unknown })?.ok === false;
    return {
      ...diagnosticSnapshot(),
      taskEvents,
      name,
      ok: !failed,
      elapsedMs: Math.round(performance.now() - startedAt),
      result,
      observedTask: taskEvents.some((event) => event.type === "task:start")
    };
  }, [diagnosticSnapshot]);

  const runDiagnosticScenario = useCallback(async (payload: DiagnosticScenarioPayload): Promise<DiagnosticScenarioResult> => {
    const id = payload.id || crypto.randomUUID();
    const tools = (Array.isArray(payload.tools) && payload.tools.length
      ? payload.tools
      : [{ name: String(payload.name || "").trim(), args: payload.args ?? {} }]
    ).filter((item) => String(item.name || "").trim());
    if (!tools.length) throw new Error("Missing diagnostic tool name.");
    const cancelAfterMs = Number(payload.cancelAfterMs);
    const cancelTimer = Number.isFinite(cancelAfterMs) && cancelAfterMs >= 0
      ? window.setTimeout(() => cancelCurrentTask(), cancelAfterMs)
      : null;
    try {
      const results = payload.parallel
        ? await Promise.all(tools.map((item) => runDiagnosticTool(String(item.name).trim(), item.args ?? {})))
        : await tools.reduce<Promise<ToolDiagnosticResult[]>>(async (previous, item) => {
            const results = await previous;
            results.push(await runDiagnosticTool(String(item.name).trim(), item.args ?? {}));
            return results;
          }, Promise.resolve([]));
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      return { id, ok: results.every((result) => result.ok), results, ...diagnosticSnapshot() };
    } finally {
      if (cancelTimer) window.clearTimeout(cancelTimer);
    }
  }, [cancelCurrentTask, diagnosticSnapshot, runDiagnosticTool]);

  useEffect(() => {
    if (!isDiagnosticsEnabled()) return;
    const publishResult = (payload: unknown) => {
      document.documentElement.dataset.discuzDiagnosticResult = JSON.stringify(payload);
    };
    const handleRunTool = (event: Event) => {
      const detail = (event as CustomEvent<DiagnosticScenarioPayload>).detail ?? {};
      runDiagnosticScenario(detail)
        .then((result) => {
          publishResult(result);
          document.dispatchEvent(new CustomEvent("discuz:tool-result", { detail: result }));
        })
        .catch((err) => {
          const id = detail.id || crypto.randomUUID();
          const payload = { id, ok: false, error: err instanceof Error ? err.message : "Diagnostic tool run failed." };
          publishResult(payload);
          document.dispatchEvent(new CustomEvent("discuz:tool-result", { detail: payload }));
        });
    };
    document.addEventListener("discuz:run-tool", handleRunTool);
    const diagnosticWindow = window as DiscuzDiagnosticWindow;
    diagnosticWindow.__discuzDiagnostics = {
      snapshot: diagnosticSnapshot,
      recorder: () => ({
        enabled: isConversationRecorderEnabled(),
        sessionId: conversationRecorderSessionId,
        events: conversationDiagnosticEventsRef.current
      }),
      flushRecorder: flushConversationDiagnostics,
      clearEvents: () => {
        diagnosticEventsRef.current = [];
      },
      runTool: runDiagnosticTool,
      runTools: async (items) => {
        const results: ToolDiagnosticResult[] = [];
        for (const item of items) {
          results.push(await runDiagnosticTool(item.name, item.args ?? {}));
        }
        return results;
      },
      runScenario: runDiagnosticScenario
    };
    return () => {
      document.removeEventListener("discuz:run-tool", handleRunTool);
      if (diagnosticWindow.__discuzDiagnostics?.runTool === runDiagnosticTool) delete diagnosticWindow.__discuzDiagnostics;
    };
  }, [conversationRecorderSessionId, diagnosticSnapshot, flushConversationDiagnostics, runDiagnosticScenario, runDiagnosticTool]);

  useEffect(() => {
    if (!isDiagnosticsEnabled()) return;
    const raw = new URLSearchParams(window.location.search).get("discuzDiag");
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as DiagnosticScenarioPayload;
      runDiagnosticScenario(payload)
        .then((result) => {
          document.documentElement.dataset.discuzDiagnosticResult = JSON.stringify(result);
          document.dispatchEvent(new CustomEvent("discuz:tool-result", { detail: result }));
        })
        .catch((err) => {
          document.documentElement.dataset.discuzDiagnosticResult = JSON.stringify({
            id: payload.id || crypto.randomUUID(),
            ok: false,
            error: err instanceof Error ? err.message : "Diagnostic scenario failed."
          });
        });
    } catch (err) {
      document.documentElement.dataset.discuzDiagnosticResult = JSON.stringify({
        id: crypto.randomUUID(),
        ok: false,
        error: err instanceof Error ? err.message : "Invalid diagnostic scenario."
      });
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [runDiagnosticScenario]);

  const runDiagnosticBridge = async () => {
    const payload = JSON.parse(diagnosticInput || "{}") as DiagnosticScenarioPayload;
    const diagnosticResult = await runDiagnosticScenario(payload);
    document.documentElement.dataset.discuzDiagnosticResult = JSON.stringify(diagnosticResult);
  };

  const finalizeDiscussionRecord = useCallback(async () => {
    const startedAt = voiceSessionStartedAtRef.current;
    voiceSessionStartedAtRef.current = null;
    if (!startedAt) return;
    try {
      const response = await fetch("/api/records/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startedAt })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState((current) => ({
        ...current,
        records: payload.records ?? current.records,
        activities: payload.activities ?? current.activities
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to archive discussion record");
    }
  }, []);

  const stopVoiceMeter = useCallback(() => {
    const meter = voiceMeterRef.current;
    if (!meter) return;
    cancelAnimationFrame(meter.frameId);
    meter.context.close().catch(() => undefined);
    voiceMeterRef.current = null;
    setVoiceInputLevel(0);
    setVoiceOutputLevel(0);
  }, []);

  const startVoiceMeter = useCallback((inputStream: MediaStream) => {
    stopVoiceMeter();
    const AudioContextClass = (window.AudioContext || (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext);
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const inputAnalyser = context.createAnalyser();
    inputAnalyser.fftSize = 512;
    inputAnalyser.smoothingTimeConstant = 0.35;
    const inputSource = context.createMediaStreamSource(inputStream);
    inputSource.connect(inputAnalyser);

    const meter: VoiceMeter = {
      context,
      inputAnalyser,
      inputData: new Uint8Array(inputAnalyser.fftSize),
      inputSource,
      frameId: 0
    };
    voiceMeterRef.current = meter;

    const tick = () => {
      const current = voiceMeterRef.current;
      if (!current) return;
      const inputLevel = readAnalyserLevel(current.inputAnalyser, current.inputData);
      const outputLevel = readAnalyserLevel(current.outputAnalyser, current.outputData);
      setVoiceInputLevel((previous) => previous * 0.72 + inputLevel * 0.28);
      setVoiceOutputLevel((previous) => previous * 0.72 + outputLevel * 0.28);
      current.frameId = requestAnimationFrame(tick);
    };
    meter.frameId = requestAnimationFrame(tick);
  }, [stopVoiceMeter]);

  const addVoiceOutputMeter = useCallback((outputStream: MediaStream) => {
    const meter = voiceMeterRef.current;
    if (!meter) return;
    meter.outputSource?.disconnect();
    const outputAnalyser = meter.context.createAnalyser();
    outputAnalyser.fftSize = 256;
    outputAnalyser.smoothingTimeConstant = 0.72;
    const outputSource = meter.context.createMediaStreamSource(outputStream);
    outputSource.connect(outputAnalyser);
    meter.outputAnalyser = outputAnalyser;
    meter.outputData = new Uint8Array(outputAnalyser.fftSize);
    meter.outputSource = outputSource;
  }, []);

  const disconnectVoice = useCallback(() => {
    voiceSessionRef.current += 1;
    if (voiceReconnectTimerRef.current) window.clearTimeout(voiceReconnectTimerRef.current);
    voiceReconnectTimerRef.current = null;
    clearResponseWatchdog();
    clearEmptyResponseRetry();
    pendingVoiceStopAfterResponseRef.current = "none";
    responseActiveRef.current = false;
    responsePendingRef.current = false;
    awaitingAssistantReplyRef.current = false;
    assistantResponseHadOutputRef.current = false;
    emptyResponseRetryCountRef.current = 0;
    finishAllVisibleTasks();
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopVoiceMeter();
    setVoiceState("idle");
    setStatusText("Ready");
  }, [clearEmptyResponseRetry, clearResponseWatchdog, finishAllVisibleTasks, stopVoiceMeter]);

  const stopVoice = useCallback(() => {
    disconnectVoice();
    finalizeDiscussionRecord().catch((err) => setError(err instanceof Error ? err.message : "Unable to archive discussion record"));
  }, [disconnectVoice, finalizeDiscussionRecord]);

  useEffect(() => {
    const saveAndDisconnect = () => {
      voiceSessionRef.current += 1;
      pendingVoiceStopAfterResponseRef.current = "none";
      responseActiveRef.current = false;
      responsePendingRef.current = false;
      realtimeSessionRef.current?.close();
      realtimeSessionRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const startedAt = voiceSessionStartedAtRef.current;
      if (startedAt) {
        navigator.sendBeacon?.("/api/records/finish", new Blob([JSON.stringify({ startedAt })], { type: "application/json" }));
        voiceSessionStartedAtRef.current = null;
      }
      navigator.sendBeacon?.("/api/topics/current/save", new Blob([], { type: "application/json" }));
    };
    window.addEventListener("pagehide", saveAndDisconnect);
    window.addEventListener("beforeunload", saveAndDisconnect);
    return () => {
      window.removeEventListener("pagehide", saveAndDisconnect);
      window.removeEventListener("beforeunload", saveAndDisconnect);
    };
  }, []);

  const startVoice = async () => {
    setError("");
    const sessionId = voiceSessionRef.current + 1;
    voiceSessionRef.current = sessionId;
    voiceSessionStartedAtRef.current = null;
    pendingVoiceStopAfterResponseRef.current = "none";
    assistantTranscriptRef.current = "";
    userTranscriptRef.current = "";
    awaitingAssistantReplyRef.current = false;
    assistantResponseHadOutputRef.current = false;
    emptyResponseRetryCountRef.current = 0;
    clearEmptyResponseRetry();
    setVoiceState("connecting");
    setStatusText("Connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持麦克风访问。请使用支持麦克风权限的浏览器，并通过 localhost 或 HTTPS 打开应用。");
      }
      const audioConstraint = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : {})
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      if (sessionId !== voiceSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setMicPermissionOpen(false);
      setMicPermissionDenied(false);
      refreshAudioInputDevices().catch(() => undefined);
      const inputLabel = stream.getAudioTracks()[0]?.label;
      if (inputLabel) setStatusText(`使用输入设备：${inputLabel}`);
      streamRef.current = stream;
      startVoiceMeter(stream);
      const bootstrapResponse = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transport: "webrtc", sdk: "@openai/agents/realtime" })
      });
      const bootstrap = await bootstrapResponse.json() as RealtimeSessionBootstrap | { error?: string };
      if (!bootstrapResponse.ok || !("clientSecret" in bootstrap)) {
        const errorPayload = bootstrap as { error?: string };
        throw new Error(errorPayload.error || "Unable to create realtime session");
      }
      if (sessionId !== voiceSessionRef.current) return;

      const realtimeTools = bootstrap.tools.map((definition) => tool({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters as any,
        execute: async (args) => {
          const executor = executeRealtimeToolRef.current;
          if (!executor) return { ok: false, error: "Realtime tool executor is not ready." };
          return executor(definition.name, (args ?? {}) as Record<string, any>);
        }
      }));
      const agent = new RealtimeAgent({
        name: bootstrap.settings.assistantName || "Discuz",
        instructions: bootstrap.instructions,
        voice: bootstrap.settings.realtimeVoice,
        tools: realtimeTools
      });
      const transport = new OpenAIRealtimeWebRTC({
        mediaStream: stream,
        audioElement: audioRef.current ?? undefined,
        changePeerConnection: (peer) => {
          peer.addEventListener("track", (event) => {
            if (event.streams[0]) addVoiceOutputMeter(event.streams[0]);
          });
          peer.addEventListener("connectionstatechange", () => {
            if (sessionId !== voiceSessionRef.current) return;
            if (peer.connectionState === "connected") {
              if (voiceReconnectTimerRef.current) window.clearTimeout(voiceReconnectTimerRef.current);
              voiceReconnectTimerRef.current = null;
              voiceSessionStartedAtRef.current ||= new Date().toISOString();
              setVoiceState("live");
              setStatusText("Live");
            }
            if (peer.connectionState === "disconnected") {
              setStatusText("连接波动，正在恢复");
              if (!voiceReconnectTimerRef.current) {
                voiceReconnectTimerRef.current = window.setTimeout(() => {
                  voiceReconnectTimerRef.current = null;
                  if (sessionId === voiceSessionRef.current && peer.connectionState === "disconnected") stopVoice();
                }, 8000);
              }
            }
            if (["failed", "closed"].includes(peer.connectionState)) stopVoice();
          });
          return peer;
        }
      });
      const realtimeTurnDetection = normalizeRealtimeTurnDetection(
        bootstrap.audio.input?.turnDetection ?? bootstrap.audio.input?.turn_detection
      );
      const session = new RealtimeSession(agent, {
        model: bootstrap.model,
        transport,
        config: {
          outputModalities: ["audio"],
          toolChoice: "auto",
          parallelToolCalls: true,
          audio: {
            input: {
              transcription: bootstrap.audio.input?.transcription ?? { model: bootstrap.settings.transcriptionModel, language: "zh" },
              turnDetection: realtimeTurnDetection as any
            },
            output: { voice: bootstrap.audio.output?.voice ?? bootstrap.settings.realtimeVoice }
          }
        }
      });
      realtimeSessionRef.current = session;

      session.on("agent_tool_start", (...values: unknown[]) => {
        if (sessionId !== voiceSessionRef.current) return;
        const name = realtimeEventToolName(...values);
        recordConversationDiagnostic("agent_tool_start", { name, values });
        finishUniqueTask(`approval-${name || "tool"}`);
        finishResponseTask();
      });
      session.on("agent_tool_end", (...values: unknown[]) => {
        if (sessionId !== voiceSessionRef.current) return;
        recordConversationDiagnostic("agent_tool_end", { values });
        if (responseActiveRef.current) scheduleResponseTask("AI整理结果");
        window.setTimeout(() => requestRealtimeResponse(), 0);
      });
      session.on("tool_approval_requested", (...values: unknown[]) => {
        if (sessionId !== voiceSessionRef.current) return;
        const name = realtimeEventToolName(...values);
        recordConversationDiagnostic("tool_approval_requested", { name, values });
        beginUniqueTask(`approval-${name || "tool"}`, `${toolCallLabel(name || "工具")}等待确认`);
      });
      session.on("transport_event", (message) => {
        if (sessionId !== voiceSessionRef.current) return;
        try {
          if (!String(message.type || "").endsWith(".delta")) {
            recordConversationDiagnostic("realtime_event", message);
          }
          if (message.type === "input_audio_buffer.speech_started") {
            if (!responseActiveRef.current) {
              setVoiceState("live");
              setStatusText("正在听");
            }
          }
          if (message.type === "input_audio_buffer.speech_stopped" || message.type === "input_audio_buffer.committed") {
            if (!responseActiveRef.current) setStatusText("AI处理中");
          }
          if (message.type === "input_audio_buffer.committed") {
            clearEmptyResponseRetry();
            awaitingAssistantReplyRef.current = true;
            assistantResponseHadOutputRef.current = false;
            emptyResponseRetryCountRef.current = 0;
          }
          if (message.type === "input_audio_buffer.timeout_triggered") {
            if (!responseActiveRef.current) {
              setStatusText("检测到停顿");
            }
          }
          if (message.type === "response.created") {
            responseActiveRef.current = true;
            assistantResponseHadOutputRef.current = false;
            startResponseWatchdog();
            scheduleResponseTask("AI处理中");
            if (pendingVoiceStopAfterResponseRef.current === "awaiting_closing") {
              pendingVoiceStopAfterResponseRef.current = "closing_started";
            }
            setVoiceState("thinking");
          }
          if (
            message.type === "response.output_item.added"
            || message.type === "response.content_part.added"
            || message.type === "output_audio_buffer.started"
          ) {
            assistantResponseHadOutputRef.current = true;
          }
          if (message.type === "response.done") {
            responseActiveRef.current = false;
            clearResponseWatchdog();
            finishResponseTask();
            setVoiceState("live");
            if (pendingTaskCountRef.current === 0 && !backgroundParsingActiveRef.current) setStatusText("Live");
            const responseOutput = Array.isArray(message.response?.output) ? message.response.output : [];
            const responseStatus = String(message.response?.status || "");
            const responseError = message.response?.status_details?.error?.message || "";
            const hadAudibleOutput = assistantResponseHadOutputRef.current || responseOutput.length > 0;
            if (
              awaitingAssistantReplyRef.current
              && !hadAudibleOutput
              && responseStatus !== "cancelled"
              && pendingVoiceStopAfterResponseRef.current === "none"
              && scheduleEmptyResponseRetry(sessionId, responseError)
            ) {
              window.setTimeout(() => flushRealtimeResponse(), 0);
              return;
            }
            if (pendingVoiceStopAfterResponseRef.current === "closing_started") {
              pendingVoiceStopAfterResponseRef.current = "none";
              setStatusText("讨论已结束");
              window.setTimeout(() => {
                if (sessionId === voiceSessionRef.current) stopVoice();
              }, 1600);
              return;
            }
            if (requestDirectionsAfterConfirmedTopic()) return;
            window.setTimeout(() => flushRealtimeResponse(), 0);
          }
          if (message.type === "response.cancelled" || message.type === "response.incomplete") {
            responseActiveRef.current = false;
            clearResponseWatchdog();
            finishResponseTask();
            setVoiceState("live");
            window.setTimeout(() => flushRealtimeResponse(), 0);
          }
          if (message.type === "response.output_audio_transcript.delta") {
            assistantResponseHadOutputRef.current = true;
            assistantTranscriptRef.current += message.delta;
            setTranscript(assistantTranscriptRef.current.slice(-220));
          }
          if (message.type === "response.output_audio_transcript.done") {
            const text = String(message.transcript || assistantTranscriptRef.current || "").trim();
            if (text) {
              assistantResponseHadOutputRef.current = true;
              awaitingAssistantReplyRef.current = false;
              emptyResponseRetryCountRef.current = 0;
              clearEmptyResponseRetry();
              saveMeetingMessage(text, "assistant").catch((err) => setError(err instanceof Error ? err.message : "Unable to save meeting record"));
            }
            assistantTranscriptRef.current = "";
          }
          if (message.type === "conversation.item.input_audio_transcription.delta") {
            userTranscriptRef.current += message.delta;
            setTranscript(userTranscriptRef.current.slice(-220));
          }
          if (message.type === "conversation.item.input_audio_transcription.completed") {
            const text = String(message.transcript || userTranscriptRef.current || "").trim();
            if (text) {
              saveMeetingMessage(text, "user").catch((err) => setError(err instanceof Error ? err.message : "Unable to save meeting record"));
              handleSpokenConfirmation(text).catch((err) => setError(err instanceof Error ? err.message : "Unable to handle confirmation"));
            }
            userTranscriptRef.current = "";
          }
          if (message.type === "error") {
            const messageText = message.error?.message || "Realtime error";
            if (/active response in progress/i.test(messageText)) {
              responseActiveRef.current = true;
              responsePendingRef.current = true;
              setStatusText("上一轮还在处理");
              setVoiceState("thinking");
              startResponseWatchdog();
              scheduleResponseTask("AI处理中");
              return;
            }
            responseActiveRef.current = false;
            clearResponseWatchdog();
            finishAllVisibleTasks();
            setError(messageText);
            setVoiceState("error");
          }
        } catch {
          setTranscript(JSON.stringify(message).slice(-220));
        }
      });
      session.on("audio_start", () => {
        if (sessionId !== voiceSessionRef.current) return;
        responseActiveRef.current = true;
        assistantResponseHadOutputRef.current = true;
        finishResponseTask();
        setVoiceState("thinking");
        startResponseWatchdog();
      });
      session.on("audio_stopped", () => {
        if (sessionId !== voiceSessionRef.current) return;
        setVoiceState(responseActiveRef.current ? "thinking" : "live");
      });
      session.on("audio_interrupted", () => {
        if (sessionId !== voiceSessionRef.current) return;
        responseActiveRef.current = false;
        clearResponseWatchdog();
        finishResponseTask();
        setVoiceState("live");
      });
      session.on("error", (sessionError) => {
        if (sessionId !== voiceSessionRef.current) return;
        responseActiveRef.current = false;
        clearResponseWatchdog();
        finishAllVisibleTasks();
        setError(sessionError.error instanceof Error ? sessionError.error.message : "Realtime error");
        setVoiceState("error");
      });

      await session.connect({ apiKey: bootstrap.clientSecret, model: bootstrap.model });
      if (sessionId !== voiceSessionRef.current) return;
      voiceSessionStartedAtRef.current ||= new Date().toISOString();
      setVoiceState("live");
      setStatusText("Live");
    } catch (err) {
      if (sessionId !== voiceSessionRef.current) return;
      stopVoice();
      setVoiceState("error");
      setStatusText("Error");
      setError(voiceStartErrorMessage(err));
      if (isVoicePermissionError(err)) {
        setMicPermissionDenied(true);
        setMicPermissionOpen(true);
      }
    }
  };

  const requestVoiceStart = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPermissionOpen(true);
      setStatusText("需要麦克风权限");
      return;
    }
    try {
      const permission = await navigator.permissions?.query?.({ name: "microphone" as never });
      if (permission?.state === "granted") {
        await startVoice();
        return;
      }
      setMicPermissionDenied(permission?.state === "denied");
      setStatusText(permission?.state === "denied" ? "麦克风权限被拒绝" : "等待麦克风授权");
      setMicPermissionOpen(true);
    } catch {
      setStatusText("等待麦克风授权");
      setMicPermissionOpen(true);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLElement>, target: DiscuzFile["role"]) => {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);
    setDraggingFile(null);
    const draggedFileId = event.dataTransfer.getData(fileDragType);
    if (draggedFileId) {
      const file = state.files.find((item) => item.id === draggedFileId);
      if (file) {
        if (target === "generated" && file.role !== "generated") await copyFileToGenerated(file);
        else await moveFileToRole(file, target);
      }
      return;
    }
    if (target === "primary") await setPrimary(event.dataTransfer.files);
    else if (target === "context") await addContext(event.dataTransfer.files);
    else if (target === "generated") await addGeneratedFiles(event.dataTransfer.files);
  };

  const reorderPrimaryFiles = async (draggedId: string, targetId: string, after: boolean) => {
    if (draggedId === targetId) return;
    const draggedFile = state.files.find((file) => file.id === draggedId);
    const targetFile = state.files.find((file) => file.id === targetId);
    if (!draggedFile || !targetFile || draggedFile.role !== "primary" || targetFile.role !== "primary") return;
    const orderedPrimaryFiles = moveItemByDrop(primaryFiles, draggedId, targetId, after);
    setState((current) => {
      const reorderedPrimary = moveItemByDrop(current.files.filter((file) => file.role === "primary"), draggedId, targetId, after);
      const queue = [...reorderedPrimary];
      return {
        ...current,
        files: current.files.map((file) => file.role === "primary" ? queue.shift() ?? file : file)
      };
    });
    const response = await fetch("/api/files/primary/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: orderedPrimaryFiles.map((file) => file.id) })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setState((current) => ({ ...current, files: payload.files ?? current.files }));
  };

  const handlePrimaryCardDrop = async (event: DragEvent<HTMLElement>, targetFile: DiscuzFile) => {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);
    setDraggingFile(null);
    const draggedFileId = event.dataTransfer.getData(fileDragType);
    if (!draggedFileId) return;
    const draggedFile = state.files.find((file) => file.id === draggedFileId);
    if (!draggedFile) return;
    if (draggedFile.role === "primary") {
      await reorderPrimaryFiles(draggedFileId, targetFile.id, shouldDropAfter(event));
      return;
    }
    await moveFileToRole(draggedFile, "primary");
  };

  const onPrimaryChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await setPrimary(event.target.files || []);
    event.target.value = "";
  };

  const onContextChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await addContext(event.target.files || []);
    event.target.value = "";
  };

  const onGeneratedChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await addGeneratedFiles(event.target.files || []);
    event.target.value = "";
  };

  const deleteFile = async (file: DiscuzFile) => {
    if (!window.confirm(`删除“${file.originalName}”？`)) return;
    const wasPrimary = file.role === "primary";
    const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setState((current) => ({ ...current, files: payload.files, activities: payload.activities, topics: payload.topics ?? current.topics }));
    if (selectedId === file.id) setSelectedId(payload.files[0]?.id ?? null);
    if (previewFileId === file.id) setPreviewFileId(null);
    if (generatedEditorId === file.id) setGeneratedEditorId(null);
    if (wasPrimary) notifyPrimaryFileDeleted(file);
    setError("");
  };

  const clearDiscussion = async () => {
    setClearConfirmOpen(false);
    disconnectVoice();
    await finalizeDiscussionRecord();
    const response = await fetch("/api/discussion/reset", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    resetLocalDiscussionView(await response.json());
  };

  const resetLocalDiscussionView = (payload: Partial<AppState>) => {
    setState((current) => ({ ...current, ...payload }));
    const nextFiles = payload.files ?? [];
    setSelectedId(nextFiles.find((file) => file.role === "primary")?.id ?? nextFiles[0]?.id ?? null);
    setPreviewFileId(null);
    setPreviewRecordId(null);
    setGeneratedEditorId(null);
    setActiveTool(null);
    setWebPreview(null);
    setTopicProposal(null);
    topicProposalRef.current = null;
    setDirectionProposal(null);
    directionProposalRef.current = null;
    setDiscussionText("");
    setError("");
    setTranscript("");
    setPendingTasks([]);
    setStatusText("Ready");
    setStatusLog([{ id: crypto.randomUUID(), kind: "status", text: "Ready", createdAt: new Date().toISOString() }]);
    lastStatusLogRef.current = "Ready";
    lastErrorLogRef.current = "";
    assistantTranscriptRef.current = "";
    userTranscriptRef.current = "";
    awaitingAssistantReplyRef.current = false;
    assistantResponseHadOutputRef.current = false;
    emptyResponseRetryCountRef.current = 0;
    clearEmptyResponseRetry();
  };

  const createNewTopic = async () => {
    if (!window.confirm("新建一个空白讨论主题？当前话题会保存，并切换到新的空白话题。")) return;
    disconnectVoice();
    await finalizeDiscussionRecord();
    const response = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error(await response.text());
    resetLocalDiscussionView(await response.json());
    setSettingsOpen(false);
  };

  const importTopic = async (topicId: string) => {
    if (!topicId || topicId === state.activeTopicId) return;
    disconnectVoice();
    await finalizeDiscussionRecord();
    const response = await fetch(`/api/topics/${encodeURIComponent(topicId)}/switch`, { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    resetLocalDiscussionView(await response.json());
    setSettingsOpen(false);
  };

  const deleteTopic = async (topicId: string) => {
    const topic = state.topics.find((item) => item.id === topicId);
    if (!topic) return;
    if (!window.confirm(`删除历史话题“${topic.title}”？所有主题文件、资源、临时文件和历史记录都会删除。`)) return;
    if (topicId === state.activeTopicId) {
      disconnectVoice();
      await finalizeDiscussionRecord();
    }
    const response = await fetch(`/api/topics/${encodeURIComponent(topicId)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    resetLocalDiscussionView(await response.json());
  };

  const hasAgendaCard = Boolean(state.discussionTopic || topicProposal || state.directions.length > 0 || directionProposal);
  const hasTopicCards = primaryFiles.length > 0 || hasAgendaCard;

  return (
    <main
      className="app-shell"
      style={{
        gridTemplateColumns: `${leftWidth}% 10px minmax(280px, 1fr)`,
        width: `${100 / layoutScale}vw`,
        height: `${100 / layoutScale}vh`,
        minHeight: `${100 / layoutScale}vh`,
        transform: `scale(${layoutScale})`,
        "--topic-pane-width": `${leftWidth}%`,
        "--wallpaper-url": `url("${state.settings?.wallpaperUrl || "/assets/default-wallpaper.png"}")`
      } as CSSProperties}
    >
      <input ref={primaryInputRef} hidden type="file" multiple onChange={onPrimaryChange} />
      <input ref={contextInputRef} hidden type="file" multiple onChange={onContextChange} />
      <input ref={generatedInputRef} hidden type="file" multiple onChange={onGeneratedChange} />
      <audio ref={audioRef} autoPlay />
      <div className="light-wash" />
      <div className="bottom-discussion-bar">
        <StatusLogPanel ref={statusLogRef} entries={statusLog} transcript={transcript} />
        {visibleTasks.length ? <TaskIndicator tasks={visibleTasks} /> : null}
        <form
          className="discussion-text-form"
          onSubmit={(event) => {
            event.preventDefault();
            sendDiscussionInput().catch((err) => setError(err.message));
          }}
        >
          <input
            value={discussionText}
            onChange={(event) => setDiscussionText(event.target.value)}
            placeholder="输入讨论主题、观点、问题或链接"
          />
          <button type="submit" title="Send discussion input" disabled={!discussionText.trim()}>
            <Send size={17} />
          </button>
        </form>
        <div className="voice-dock">
          <VoiceButton state={voiceState} onStart={requestVoiceStart} onStop={stopVoice} />
        </div>
        <VoiceLevelBars state={voiceState} inputLevel={voiceInputLevel} outputLevel={voiceOutputLevel} />
      </div>

      <section
        ref={topicPanelRef}
        className={`panel topic-panel ${dragTarget === "primary" ? "dragging" : ""} ${fullscreenPanel === "topic" ? "fullscreen-panel" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragTarget("primary");
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragTarget(null)}
        onDrop={(event) => handleDrop(event, "primary")}
      >
        <PanelHeader
          title="主题"
          meta=""
          action={
            <div className="header-actions">
              <button className="icon-button" title={fullscreenPanel === "topic" ? "Exit fullscreen topic" : "Fullscreen topic"} onClick={() => setFullscreenPanel(fullscreenPanel === "topic" ? null : "topic")}>
                {fullscreenPanel === "topic" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
              <button className="icon-button" title="新建主题" onClick={() => createNewTopic().catch((err) => setError(err.message))}><Plus size={17} /></button>
              <button className="icon-button danger" title="Clear discussion" onClick={() => setClearConfirmOpen(true)}><Trash2 size={17} /></button>
              <button className="icon-button" title="Choose file" onClick={() => primaryInputRef.current?.click()}><FilePlus2 size={18} /></button>
              <button ref={settingsButtonRef} className="icon-button" title="Settings" onClick={toggleSettingsPopover}><Settings2 size={18} /></button>
            </div>
          }
        />
        <div className="topic-preview">
          {hasTopicCards ? (
            <div className="topic-file-list">
              {hasAgendaCard && (
                <TopicAgendaCard
                  currentTopic={state.discussionTopic}
                  topicProposal={topicProposal}
                  onConfirmTopic={(title) => confirmDiscussionTopic(title).catch((err) => setError(err.message))}
                  onDismissTopic={() => {
                    topicProposalRef.current = null;
                    setTopicProposal(null);
                  }}
                  directions={state.directions}
                  directionProposal={directionProposal}
                  onConfirmDirections={() => directionProposal && confirmDirectionProposal(directionProposal.directions).catch((err) => setError(err.message))}
                  onDismissDirections={() => {
                    directionProposalRef.current = null;
                    setDirectionProposal(null);
                  }}
                  onComplete={(direction) => completeDirection(direction).catch((err) => setError(err.message))}
                  onDelete={(direction) => deleteDirection(direction).catch((err) => setError(err.message))}
                />
              )}
              {primaryFiles.map((file) => (
                <article
                  key={file.id}
                  className={`topic-file-card ${selectedId === file.id ? "selected" : ""} ${draggingFile?.id === file.id ? "dragging-card" : ""}`}
                  draggable
                  onClick={() => setSelectedId(file.id)}
                  onDoubleClick={() => openFileDiscussionWindow(file)}
                  onDragStart={(event) => {
                    setDraggingFile({ id: file.id, role: file.role });
                    event.dataTransfer.setData(fileDragType, file.id);
                    event.dataTransfer.effectAllowed = "move";
                    setCardDragImage(event);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onDrop={(event) => handlePrimaryCardDrop(event, file).catch((err) => setError(err.message))}
                  onDragEnd={() => setDraggingFile(null)}
                >
                  {draggingFile?.id === file.id ? (
                    <span className="transfer-badge demote"><Minus size={17} /></span>
                  ) : (
                    <div className="card-actions">
                      <button
                        className="card-export"
                        title="导出文件"
                        onClick={(event) => {
                          event.stopPropagation();
                          downloadUploadedFile(file);
                          setStatusText("文件已导出");
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <Download size={14} />
                      </button>
                      {file.kind !== "image" && (
                        <button
                          className="card-copy"
                          title="复制到临时文件区编辑"
                          onClick={(event) => {
                            event.stopPropagation();
                            copyFileToGenerated(file).catch((err) => setError(err.message));
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          <Copy size={14} />
                        </button>
                      )}
                      <button
                        className="card-delete"
                        title="Delete topic file"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteFile(file).catch((err) => setError(err.message));
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                  <div className="topic-card-preview">
                    <FileMiniPreview file={file} />
                  </div>
                  <footer>
                    <span>{file.kind}</span>
                    <strong>{file.originalName}</strong>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <EmptyTopic onChoose={() => primaryInputRef.current?.click()} />
          )}
        </div>
      </section>

      <div className="column-resizer" onPointerDown={startColumnResize} />

      <section
        className="right-stack"
        style={{ gridTemplateRows: `minmax(0, ${rightResourceHeight}fr) 10px minmax(0, ${generatedHeight}fr) 10px minmax(0, ${rightRecordHeight}fr)` }}
      >
        <section
          className={`panel resource-panel ${dragTarget === "context" ? "dragging" : ""} ${fullscreenPanel === "resources" ? "fullscreen-panel" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragTarget("context");
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragTarget(null)}
          onDrop={(event) => handleDrop(event, "context")}
        >
          <PanelHeader
            title="资源"
            meta=""
            action={
              <div className="header-actions">
                <button className="icon-button" title={fullscreenPanel === "resources" ? "Exit fullscreen resources" : "Fullscreen resources"} onClick={() => setFullscreenPanel(fullscreenPanel === "resources" ? null : "resources")}>
                  {fullscreenPanel === "resources" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
                <button className="icon-button" title="Add resources" onClick={() => contextInputRef.current?.click()}><FilePlus2 size={18} /></button>
              </div>
            }
          />
          <section
            className={`resource-zone ${dragTarget === "context" ? "zone-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragTarget("context");
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDragLeave={() => setDragTarget(null)}
            onDrop={(event) => handleDrop(event, "context")}
          >
            <div className="resource-grid">
              {contextFiles.map((file) => (
                <FileThumb
                  key={file.id}
                  file={file}
                  selected={selectedFile?.id === file.id}
                  onSelect={() => setSelectedId(file.id)}
                  onOpen={() => openFileDiscussionWindow(file)}
                  onDelete={() => deleteFile(file).catch((err) => setError(err.message))}
                  onDownload={() => {
                    downloadUploadedFile(file);
                    setStatusText("文件已导出");
                  }}
                  onCopy={file.kind === "image" ? undefined : () => copyFileToGenerated(file).catch((err) => setError(err.message))}
                  onDragStart={(event) => {
                    setDraggingFile({ id: file.id, role: file.role });
                    event.dataTransfer.setData(fileDragType, file.id);
                    event.dataTransfer.effectAllowed = "move";
                    setCardDragImage(event);
                  }}
                  onDragEnd={() => setDraggingFile(null)}
                  dragMark={draggingFile?.id === file.id ? "add" : null}
                />
              ))}
              {!contextFiles.length && (
                <button className="thumb add-file-card" onClick={() => contextInputRef.current?.click()}>
                  <FileText size={24} />
                  <span>添加资源文件</span>
                </button>
              )}
            </div>
          </section>
        </section>

        <div className="row-resizer" onPointerDown={startRowResize} />

        <section
          className={`panel generated-panel ${dragTarget === "generated" ? "dragging" : ""} ${fullscreenPanel === "generated" ? "fullscreen-panel" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragTarget("generated");
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragTarget(null)}
          onDrop={(event) => handleDrop(event, "generated")}
        >
          <PanelHeader
            title="临时文件"
            meta="AI 生成与可编辑副本"
            action={
              <div className="header-actions">
                <button className="icon-button" title="Whiteboard" onClick={() => openToolDiscussionWindow("whiteboard")}><PenLine size={17} /></button>
                <button className="icon-button" title="Temporary draft" onClick={() => openToolDiscussionWindow("draft")}><FileText size={17} /></button>
                <button className="icon-button" title={fullscreenPanel === "generated" ? "Exit fullscreen temporary files" : "Fullscreen temporary files"} onClick={() => setFullscreenPanel(fullscreenPanel === "generated" ? null : "generated")}>
                  {fullscreenPanel === "generated" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
                <button className="icon-button" title="Add temporary files" onClick={() => generatedInputRef.current?.click()}><FilePlus2 size={18} /></button>
              </div>
            }
          />
          <section
            className={`resource-zone ${dragTarget === "generated" ? "zone-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragTarget("generated");
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDragLeave={() => setDragTarget(null)}
            onDrop={(event) => handleDrop(event, "generated")}
          >
            <div className="resource-grid">
              {generatedFiles.map((file) => (
                <FileThumb
                  key={file.id}
                  file={file}
                  selected={selectedFile?.id === file.id}
                  onSelect={() => setSelectedId(file.id)}
                  onOpen={() => openFileDiscussionWindow(file)}
                  onDelete={() => deleteFile(file).catch((err) => setError(err.message))}
                  onDownload={() => {
                    downloadUploadedFile(file);
                    setStatusText("文件已导出");
                  }}
                  onDragStart={(event) => {
                    setDraggingFile({ id: file.id, role: file.role });
                    event.dataTransfer.setData(fileDragType, file.id);
                    event.dataTransfer.effectAllowed = "move";
                    setCardDragImage(event);
                  }}
                  onDragEnd={() => setDraggingFile(null)}
                  dragMark={draggingFile?.id === file.id ? "add" : null}
                />
              ))}
              {!generatedFiles.length && (
                <button className="thumb add-file-card" onClick={() => generatedInputRef.current?.click()}>
                  <FileText size={24} />
                  <span>添加临时文件</span>
                </button>
              )}
            </div>
          </section>
        </section>

        <div className="row-resizer" onPointerDown={startGeneratedRecordResize} />

        <section className={`panel record-panel ${fullscreenPanel === "record" ? "fullscreen-panel" : ""}`}>
          <PanelHeader
            title="记录"
            meta=""
            action={
              <div className="header-actions">
                <button className="icon-button" title={fullscreenPanel === "record" ? "Exit fullscreen record" : "Fullscreen record"} onClick={() => setFullscreenPanel(fullscreenPanel === "record" ? null : "record")}>
                  {fullscreenPanel === "record" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
              </div>
            }
          />
          <div className="record-list">
            <section className="record-current">
              <header>
                <div className="record-title-block">
                  <strong>会议记录</strong>
                  <span>{meetingRecordEnabled ? `${meetingMessages.length} 段` : "已关闭"}</span>
                </div>
                <div className="record-section-actions">
                  <button className="icon-button compact export-button" title="导出会议记录" aria-label="导出会议记录" onClick={exportMeetingRecord}>
                    <Download size={15} />
                  </button>
                  <button
                    className={meetingRecordEnabled ? "toggle record-toggle enabled" : "toggle record-toggle"}
                    title={meetingRecordEnabled ? "关闭会议记录" : "打开会议记录"}
                    aria-label={meetingRecordEnabled ? "关闭会议记录" : "打开会议记录"}
                    aria-pressed={meetingRecordEnabled}
                    onClick={() => setMeetingRecordEnabled((value) => !value)}
                  >
                    <span />
                  </button>
                </div>
              </header>
              <div className={`record-stream ${meetingMessages.length ? "" : "has-empty-record"}`} ref={recordStreamRef}>
                {meetingMessages.length ? (
                  meetingMessages.map((message) => (
                    <article key={message.id} className={`note-line ${message.role}`}>
                      <span>{message.role === "assistant" ? "AI" : "用户"} · {shortTime(message.createdAt)}</span>
                      <p>{message.text}</p>
                    </article>
                  ))
                ) : (
                  <div className="empty-record">
                    <CheckCircle2 size={22} />
                    <span>对话内容会在这里记录</span>
                  </div>
                )}
              </div>
            </section>
            <section className="record-history">
              <header>
                <div className="record-title-block">
                  <strong>要点</strong>
                  <span>{currentNotes.length} 段</span>
                </div>
                <div className="record-section-actions">
                  <button className="icon-button compact export-button" title="导出要点" aria-label="导出要点" onClick={exportNotes}>
                    <Download size={15} />
                  </button>
                </div>
              </header>
              <div className={`history-card-list ${currentNotes.length ? "" : "has-empty-record"}`}>
                {currentNotes.length ? (
                  currentNotes.map((note) => (
                    <article key={note.id} className="history-card">
                      <span>{noteLabel(note.kind)} · {shortTime(note.createdAt)}</span>
                      <strong>{note.source || "AI summary"}</strong>
                      <p>{note.text}</p>
                    </article>
                  ))
                ) : (
                  <div className="empty-record">
                    <FileText size={22} />
                    <span>讨论要点会自动总结</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      </section>

      {settingsOpen && (
        <SettingsPopover
          ref={settingsPopoverRef}
          settings={state.settings ?? emptyState.settings!}
          webEnabled={webEnabled}
          setWebEnabled={setWebEnabled}
          audioInputDevices={audioInputDevices}
          selectedAudioInputId={selectedAudioInputId}
          setSelectedAudioInputId={setSelectedAudioInputId}
          onRefreshAudioInputs={() => refreshAudioInputDevices().catch((err) => setError(err instanceof Error ? err.message : "无法刷新输入设备"))}
          topics={state.topics}
          activeTopicId={state.activeTopicId}
          onImportTopic={(topicId) => importTopic(topicId).catch((err) => setError(err.message))}
          onDeleteTopic={(topicId) => deleteTopic(topicId).catch((err) => setError(err.message))}
          onSettingsSaved={(settings) => setState((current) => ({ ...current, settings }))}
          onClose={() => setSettingsOpen(false)}
          style={settingsPopoverStyle}
        />
      )}
      {micPermissionOpen && (
        <MicrophonePermissionWindow
          denied={micPermissionDenied}
          onRequest={() => {
            startVoice().catch((err) => setError(err instanceof Error ? err.message : "无法启动语音。"));
          }}
          onClose={() => setMicPermissionOpen(false)}
        />
      )}
      {clearConfirmOpen && (
        <ClearDiscussionConfirm
          onConfirm={() => clearDiscussion().catch((err) => setError(err.message))}
          onClose={() => setClearConfirmOpen(false)}
        />
      )}
      {activeTool && (
        <ToolWindow
          tool={activeTool}
          selectedFile={selectedFile}
          draftText={draftText}
          setDraftText={setDraftText}
          boardItems={boardItems}
          setBoardItems={setBoardItems}
          boardLinks={boardLinks}
          drawPoints={drawPoints}
          setDrawPoints={setDrawPoints}
          boardRef={boardRef}
          drawing={drawing}
          setDrawing={setDrawing}
          layoutScale={layoutScale}
          onSave={() => saveToolToGenerated(activeTool).catch((err) => setError(err.message))}
          onClear={() => clearToolContent(activeTool)}
          onClose={() => setActiveTool(null)}
        />
      )}
      {previewFile && (
        <FilePreviewWindow
          file={previewFile}
          topicFrame={previewFile.role === "primary" ? topicPreviewFrame : null}
          onClose={() => setPreviewFileId(null)}
        />
      )}
      {webPreview && <WebPreviewWindow page={webPreview} onClose={() => setWebPreview(null)} />}
      {previewRecord && <RecordPreviewWindow record={previewRecord} onClose={() => setPreviewRecordId(null)} />}
      {generatedEditorFile && (
        <GeneratedFileEditor
          file={generatedEditorFile}
          onSave={(text) => updateGeneratedFile(generatedEditorFile, text)}
          onPromote={() => promoteGeneratedFile(generatedEditorFile)}
          onClose={() => setGeneratedEditorId(null)}
        />
      )}
      {isDiagnosticsEnabled() && (
        <form
          data-testid="discuz-diagnostic-form"
          aria-label="Discuz diagnostic runner"
          style={{ position: "fixed", left: 0, bottom: 0, zIndex: 10000, width: 120, height: 48, opacity: 0.01, overflow: "hidden" }}
          onSubmit={(event) => {
            event.preventDefault();
            runDiagnosticBridge().catch((err) => {
              document.documentElement.dataset.discuzDiagnosticResult = JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : "Diagnostic bridge failed."
              });
            });
          }}
        >
          <textarea
            data-testid="discuz-diagnostic-input"
            aria-label="Diagnostic input"
            value={diagnosticInput}
            onChange={(event) => setDiagnosticInput(event.target.value)}
            style={{ width: 80, height: 32 }}
          />
          <button data-testid="discuz-diagnostic-run" type="submit" style={{ width: 32, height: 32 }}>Run</button>
        </form>
      )}
    </main>
  );
}

function PanelHeader({ title, meta, center, action }: { title: string; meta?: string; center?: ReactNode; action: ReactNode }) {
  return (
    <header className="panel-head">
      <div className="panel-title">
        <h2>{title}</h2>
        {meta && <p>{meta}</p>}
      </div>
      {center}
      {action}
    </header>
  );
}

function TopicAgendaCard({
  currentTopic,
  topicProposal,
  onConfirmTopic,
  onDismissTopic,
  directions,
  directionProposal,
  onConfirmDirections,
  onDismissDirections,
  onComplete,
  onDelete
}: {
  currentTopic: string;
  topicProposal: TopicProposal | null;
  onConfirmTopic: (_title: string) => void;
  onDismissTopic: () => void;
  directions: DiscussionDirection[];
  directionProposal: DirectionProposal | null;
  onConfirmDirections: () => void;
  onDismissDirections: () => void;
  onComplete: (_direction: DiscussionDirection) => void;
  onDelete: (_direction: DiscussionDirection) => void;
}) {
  const proposalItems = directionProposal?.directions ?? [];
  const displayedDirections = directionProposal ? proposalItems : directions;
  const topicTitle = topicProposal?.title ?? currentTopic;
  return (
    <article className={`topic-file-card directions-card topic-agenda-card ${topicProposal?.intent === "drift" ? "drift" : ""}`}>
      <div className="topic-agenda-head">
        <div className="topic-agenda-title">
          <span>{topicProposal ? topicProposal.intent === "drift" ? "主题偏离提醒" : "AI 建议讨论主题" : "当前讨论主题"}</span>
          <strong>{topicTitle || "讨论主题待确认"}</strong>
          {topicProposal?.reason && <p>{topicProposal.reason}</p>}
        </div>
        {topicProposal && (
          <div className="directions-card-actions">
            <button title="确认主题" onClick={() => onConfirmTopic(topicProposal.title)}><Check size={14} /></button>
            <button title="关闭" onClick={onDismissTopic}><X size={14} /></button>
          </div>
        )}
      </div>
      <div className="directions-card-head">
        <span>{directionProposal ? "待确认方向" : "讨论方向"}</span>
        {directionProposal && (
          <div className="directions-card-actions">
            <button title="确认方向" onClick={onConfirmDirections}><Check size={14} /></button>
            <button title="关闭" onClick={onDismissDirections}><X size={14} /></button>
          </div>
        )}
      </div>
      {directionProposal?.reason && <p className="directions-reason">{directionProposal.reason}</p>}
      <ul className="directions-list">
        {displayedDirections.length === 0 && (
          <li className="direction-placeholder">
            <span>确认主题后，这里会显示 1 到 3 条讨论方向。</span>
          </li>
        )}
        {displayedDirections.map((item, index) => {
          const text = typeof item === "string" ? item : item.text;
          const completed = typeof item === "string" ? false : item.completed;
          return (
            <li key={typeof item === "string" ? `${text}-${index}` : item.id} className={completed ? "completed" : ""}>
              <button
                className="direction-dot"
                title={completed ? "已完成" : "标记完成"}
                disabled={Boolean(directionProposal) || completed}
                onClick={() => typeof item !== "string" && onComplete(item)}
              >
                {completed ? <CheckCircle2 size={16} /> : null}
              </button>
              <span>{text}</span>
              {typeof item !== "string" && (
                <button className="direction-delete" title="删除方向" onClick={() => onDelete(item)}>
                  <X size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

const StatusLogPanel = forwardRef<HTMLDivElement, { entries: StatusLogEntry[]; transcript: string }>(function StatusLogPanel({
  entries,
  transcript
}, ref) {
  return (
    <div className="status-log-panel" aria-live="polite">
      <div className="status-log-scroll" ref={ref}>
        <div className="status-log-content">
          {entries.map((entry) => (
            <p key={entry.id} className={entry.kind === "error" ? "error" : ""}>
              <span>{shortTime(entry.createdAt)}</span>
              {entry.text}
            </p>
          ))}
          {transcript.trim() && (
            <p>
              <span>{shortTime(new Date().toISOString())}</span>
              {transcript}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});

function TaskIndicator({ tasks }: { tasks: TaskItem[] }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (tasks.length <= 1) setExpanded(false);
  }, [tasks.length]);

  if (!tasks.length) return null;
  const active = tasks[tasks.length - 1];
  const label = tasks.length > 1 ? `正在执行 ${tasks.length} 个任务` : `${active.label}进行中`;
  return (
    <div className={`task-indicator ${expanded ? "expanded" : ""}`}>
      <button
        type="button"
        title={tasks.length > 1 ? "查看正在执行的任务" : active.label}
        aria-expanded={expanded}
        onClick={() => tasks.length > 1 && setExpanded((value) => !value)}
      >
        <Sparkles size={14} />
        <span>{label}</span>
        {tasks.length > 1 && <ChevronDown size={13} />}
      </button>
      {expanded && (
        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <span />
              {task.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyTopic({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="empty-topic">
      <div className="empty-topic-fan" aria-label="选择主题文件">
        <button className="empty-topic-card image" title="添加图片主题" aria-label="添加图片主题" onClick={onChoose}>
          <ImageIcon size={42} />
        </button>
        <button className="empty-topic-card file" title="添加文件主题" aria-label="添加文件主题" onClick={onChoose}>
          <FileText size={42} />
        </button>
        <button className="empty-topic-card chart" title="添加图表主题" aria-label="添加图表主题" onClick={onChoose}>
          <ChartNoAxesColumn size={42} />
        </button>
      </div>
      <span className="empty-topic-label">添加讨论主题文件</span>
    </div>
  );
}

function FilePreview({ file }: { file: DiscuzFile }) {
  if (file.kind === "image") return <img className="image-preview" src={file.previewUrl} alt={file.originalName} />;
  if (file.kind === "audio") return <audio className="media-preview" src={file.previewUrl} controls />;
  if (file.kind === "video") return <video className="media-preview" src={file.previewUrl} controls />;
  if (file.kind === "pdf") return <iframe className="document-frame" title={file.originalName} src={file.previewUrl} />;
  if ((file.kind === "doc" || file.kind === "docx" || file.kind === "epub") && file.renderedHtml) {
    return <iframe className="document-frame word-frame" title={file.originalName} sandbox="" srcDoc={wordPreviewHtml(file.renderedHtml)} />;
  }
  return (
    <article className="text-preview">
      <div>
        <span>{file.kind}</span>
        <h1>{file.originalName}</h1>
      </div>
      <p>{file.summary}</p>
      <pre>{file.extractedText || "No readable text extracted."}</pre>
    </article>
  );
}

function wordPreviewHtml(html: string) {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 32px; color: #17212b; font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: transparent; }
    p { margin: 0 0 0.85em; }
    table { border-collapse: collapse; max-width: 100%; }
    td, th { border: 1px solid rgba(23, 33, 43, 0.18); padding: 6px 8px; vertical-align: top; }
    img { max-width: 100%; height: auto; }
  </style></head><body>${html}</body></html>`;
}

function FileMiniPreview({ file }: { file: DiscuzFile }) {
  if (file.kind === "image") return <img src={file.previewUrl} alt="" />;
  if (file.kind === "video") return <video src={file.previewUrl} muted preload="metadata" />;
  if (file.kind === "audio") return <div className="mini-icon"><Music size={22} /></div>;
  if (file.kind === "pdf") return <div className="mini-document"><iframe title="" src={file.previewUrl} /></div>;
  if ((file.kind === "doc" || file.kind === "docx" || file.kind === "epub") && file.renderedHtml) {
    return <div className="mini-document"><iframe title="" sandbox="" srcDoc={wordPreviewHtml(file.renderedHtml)} /></div>;
  }
  const markdownImage = file.extractedText.match(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  if (markdownImage?.[1]) return <img src={markdownImage[1]} alt="" />;
  if (file.extractedText) return <pre>{file.extractedText.slice(0, 600)}</pre>;
  return <div className="mini-icon">{file.kind}</div>;
}

function FileThumb({
  file,
  selected,
  onSelect,
  onOpen,
  onDelete,
  onDownload,
  onCopy,
  onDragStart,
  onDragEnd,
  dragMark
}: {
  file: DiscuzFile;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onCopy?: () => void;
  onDragStart?: (_event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  dragMark?: "add" | null;
}) {
  return (
    <article
      className={`thumb ${selected ? "selected" : ""} ${dragMark ? "dragging-card" : ""}`}
      draggable={Boolean(onDragStart)}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {dragMark === "add" ? (
        <span className="transfer-badge promote"><Plus size={17} /></span>
      ) : (
        <div className="card-actions">
          <button
            className="card-export"
            title="导出文件"
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Download size={13} />
          </button>
          {onCopy && (
            <button
              className="card-copy"
              title="复制到临时文件区编辑"
              onClick={(event) => {
                event.stopPropagation();
                onCopy();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <Copy size={13} />
            </button>
          )}
          <button
            className="card-delete"
            title="删除文件"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
      <div className="thumb-preview">
        <FileMiniPreview file={file} />
      </div>
      <footer>
        <strong>{file.originalName}</strong>
      </footer>
    </article>
  );
}

function FilePreviewWindow({
  file,
  topicFrame,
  onClose
}: {
  file: DiscuzFile;
  topicFrame: { left: number; width: number } | null;
  onClose: () => void;
}) {
  const topicStyle = topicFrame ? {
    left: `${topicFrame.left}px`,
    width: `${topicFrame.width}px`
  } as CSSProperties : undefined;
  return (
    <aside className={`file-preview-window ${topicFrame ? "topic-file-preview-window" : ""}`} style={topicStyle}>
      <header className="tool-head">
        <strong>{file.originalName}</strong>
        <button className="icon-button" title="Close preview" onClick={onClose}>×</button>
      </header>
      <div className="file-preview-body">
        <FilePreview file={file} />
      </div>
    </aside>
  );
}

function WebPreviewWindow({ page, onClose }: { page: WebPreview; onClose: () => void }) {
  const [embedState, setEmbedState] = useState<{ embeddable: boolean | null; reason: string }>({
    embeddable: page.embeddable ?? null,
    reason: page.embedReason || ""
  });

  useEffect(() => {
    let cancelled = false;
    setEmbedState({ embeddable: page.embeddable ?? null, reason: page.embedReason || "" });
    if (isLocalPreviewUrl(page.url)) {
      setEmbedState({ embeddable: true, reason: "" });
      return () => {
        cancelled = true;
      };
    }
    fetch(`/api/web/embed-check?url=${encodeURIComponent(page.url)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        setEmbedState({
          embeddable: payload.embeddable !== false,
          reason: payload.reason || ""
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setEmbedState({ embeddable: false, reason: err instanceof Error ? err.message : "无法检测网页嵌入状态" });
      });
    return () => {
      cancelled = true;
    };
  }, [page.embeddable, page.embedReason, page.url]);

  const blocked = embedState.embeddable === false;
  return (
    <aside className="web-preview-window">
      <header className="tool-head">
        <div className="web-preview-title">
          <strong>{page.title || "网页"}</strong>
          <span>{page.url}</span>
        </div>
        <div className="header-actions">
          <a className="icon-button" title="在浏览器打开" href={page.url} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
          </a>
          <button className="icon-button" title="关闭网页窗口" onClick={onClose}>×</button>
        </div>
      </header>
      <div className="web-preview-body">
        {blocked ? (
          <div className="web-preview-blocked">
            <ExternalLink size={28} />
            <strong>这个网页不能在窗口内显示</strong>
            <span>{embedState.reason || "网站禁止被嵌入到其他页面。"}</span>
            <a href={page.url} target="_blank" rel="noreferrer">在浏览器打开</a>
          </div>
        ) : (
          <>
            <iframe title={page.title || page.url} src={page.url} />
            <p>{embedState.embeddable === null ? "正在检测网页是否允许嵌入..." : "如果网页没有显示，可点右上角打开。"}</p>
          </>
        )}
      </div>
    </aside>
  );
}

function RecordPreviewWindow({ record, onClose }: { record: DiscussionRecord; onClose: () => void }) {
  return (
    <aside className="record-preview-window">
      <header className="tool-head">
        <div>
          <strong>{record.title}</strong>
          <span>{record.noteCount} 段 · {shortTime(record.createdAt)}</span>
        </div>
        <button className="icon-button" title="Close record" onClick={onClose}>×</button>
      </header>
      <div className="record-preview-body">
        {record.content.split(/\n{2,}/).map((paragraph, index) => (
          <p key={`${record.id}-${index}`}>{paragraph}</p>
        ))}
      </div>
    </aside>
  );
}

function GeneratedFileEditor({
  file,
  onSave,
  onPromote,
  onClose
}: {
  file: DiscuzFile;
  onSave: (_text: string) => Promise<void>;
  onPromote: () => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(file.extractedText);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(file.extractedText);
  }, [file.id, file.extractedText]);

  const saveEdit = async () => {
    setSaving(true);
    try {
      await onSave(text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="generated-editor-window">
      <header className="tool-head">
        <div>
          <strong>{file.originalName}</strong>
          <span>先保存编辑，确认无误后再确认为成果</span>
        </div>
        <div className="header-actions">
          <button className="icon-button" title="保存编辑" disabled={saving} onClick={saveEdit}><Check size={16} /></button>
          <button className="icon-button" title="确认为成果" disabled={saving} onClick={() => onPromote()}><FilePlus2 size={16} /></button>
          <button className="icon-button" title="关闭编辑窗口" onClick={onClose}>×</button>
        </div>
      </header>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
      />
    </aside>
  );
}

function ToolWindow({
  tool,
  selectedFile,
  draftText,
  setDraftText,
  boardItems,
  setBoardItems,
  boardLinks,
  drawPoints,
  setDrawPoints,
  boardRef,
  drawing,
  setDrawing,
  layoutScale,
  onSave,
  onClear,
  onClose
}: {
  tool: ToolId;
  selectedFile: DiscuzFile | null;
  draftText: string;
  setDraftText: Dispatch<SetStateAction<string>>;
  boardItems: BoardItem[];
  setBoardItems: Dispatch<SetStateAction<BoardItem[]>>;
  boardLinks: BoardLink[];
  drawPoints: Array<{ id: string; x: number; y: number }>;
  setDrawPoints: Dispatch<SetStateAction<Array<{ id: string; x: number; y: number }>>>;
  boardRef: RefObject<HTMLDivElement | null>;
  drawing: boolean;
  setDrawing: Dispatch<SetStateAction<boolean>>;
  layoutScale: number;
  onSave: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draggingBoardItem, setDraggingBoardItem] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const title = {
    whiteboard: "无限白板",
    draft: "临时文档",
    image: "图像查看",
    video: "视频查看",
    audio: "录音播放"
  }[tool];

  const getBoardPoint = (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.max(layoutScale, 0.01);
    return {
      x: (event.clientX - rect.left) / scale + event.currentTarget.scrollLeft,
      y: (event.clientY - rect.top) / scale + event.currentTarget.scrollTop
    };
  };

  const addBoardText = () => {
    setBoardItems((items) => [...items, { id: crypto.randomUUID(), kind: "text", value: "新的观点", x: 80 + items.length * 24, y: 80 + items.length * 18 }]);
  };

  const addBoardImage = () => {
    if (!selectedFile || selectedFile.kind !== "image") return;
    setBoardItems((items) => [...items, { id: crypto.randomUUID(), kind: "image", value: selectedFile.previewUrl, x: 120, y: 120 }]);
  };

  const updateBoardText = (id: string, value: string) => {
    setBoardItems((items) => items.map((item) => item.id === id ? { ...item, value } : item));
  };

  const itemCenter = (item: BoardItem) => ({
    x: item.x + (item.kind === "image" ? 130 : 95),
    y: item.y + 43
  });
  const itemById = new Map(boardItems.map((item) => [item.id, item]));

  const startBoardItemDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: BoardItem) => {
    const board = boardRef.current;
    if (!board) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = board.getBoundingClientRect();
    const scale = Math.max(layoutScale, 0.01);
    const x = (event.clientX - rect.left) / scale + board.scrollLeft;
    const y = (event.clientY - rect.top) / scale + board.scrollTop;
    setDraggingBoardItem({ id: item.id, offsetX: x - item.x, offsetY: y - item.y });
  };

  useEffect(() => {
    if (!draggingBoardItem) return;
    const move = (event: PointerEvent) => {
      const board = boardRef.current;
      if (!board) return;
      const rect = board.getBoundingClientRect();
      const scale = Math.max(layoutScale, 0.01);
      const x = (event.clientX - rect.left) / scale + board.scrollLeft - draggingBoardItem.offsetX;
      const y = (event.clientY - rect.top) / scale + board.scrollTop - draggingBoardItem.offsetY;
      setBoardItems((items) => items.map((item) => item.id === draggingBoardItem.id ? {
        ...item,
        x: Math.max(12, Math.min(2380, x)),
        y: Math.max(12, Math.min(1680, y))
      } : item));
    };
    const stop = () => setDraggingBoardItem(null);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
  }, [boardRef, draggingBoardItem, layoutScale, setBoardItems]);

  return (
    <aside className="tool-window">
      <header className="tool-head">
        <strong>{title}</strong>
        <div className="header-actions">
          {tool === "whiteboard" && (
            <>
              <button className="icon-button" title="Add text" onClick={addBoardText}><FileText size={16} /></button>
              <button className="icon-button" title="Add image" onClick={addBoardImage}><ImageIcon size={16} /></button>
              <button className={`icon-button ${drawing ? "active" : ""}`} title="Draw" onClick={() => setDrawing((value) => !value)}><PenLine size={16} /></button>
            </>
          )}
          {(tool === "whiteboard" || tool === "draft") && (
            <>
              <button className="icon-button" title="保存到临时文件区" onClick={onSave}><Check size={16} /></button>
              <button className="icon-button" title="清空内容" onClick={onClear}><Trash2 size={16} /></button>
            </>
          )}
          <button className="icon-button" title="Close tool" onClick={onClose}>×</button>
        </div>
      </header>

      {tool === "draft" && (
        <div className="draft-tool">
          <p>这里保存文件修改样板。原始文件始终保留，只有用户确认后才可覆盖。</p>
          <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="写入拟修改内容、替换段落、版本说明..." />
        </div>
      )}

      {tool === "whiteboard" && (
        <div
          ref={boardRef}
          className={`infinite-board ${drawing ? "drawing" : ""}`}
          onPointerMove={(event) => {
            if (!drawing || event.buttons !== 1) return;
            const point = getBoardPoint(event);
            setDrawPoints((points) => [...points, {
              id: crypto.randomUUID(),
              x: point.x,
              y: point.y
            }].slice(-2200));
          }}
          onDoubleClick={(event) => {
            const point = getBoardPoint(event);
            setBoardItems((items) => [...items, { id: crypto.randomUUID(), kind: "text", value: "双击添加", x: point.x, y: point.y }]);
          }}
        >
          <div className="board-canvas">
            <svg className="board-links" viewBox="0 0 2600 1800" aria-hidden="true">
              {boardLinks.map((link) => {
                const from = itemById.get(link.from);
                const to = itemById.get(link.to);
                if (!from || !to) return null;
                const start = itemCenter(from);
                const end = itemCenter(to);
                return <line key={link.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
              })}
            </svg>
            {drawPoints.map((point) => <i key={point.id} className="draw-point" style={{ left: point.x, top: point.y }} />)}
            {boardItems.map((item) => (
              <div key={item.id} className={`board-item ${item.kind}`} style={{ left: item.x, top: item.y }}>
                <button
                  className="board-drag-handle"
                  title="拖动节点"
                  onPointerDown={(event) => startBoardItemDrag(event, item)}
                />
                {item.kind === "image" ? <img src={item.value} alt="" /> : <textarea value={item.value} onChange={(event) => updateBoardText(item.id, event.target.value)} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {["image", "video", "audio"].includes(tool) && (
        <div className="media-tool">
          {selectedFile?.kind === "image" && <img src={selectedFile.previewUrl} alt={selectedFile.originalName} />}
          {selectedFile?.kind === "video" && <video src={selectedFile.previewUrl} controls />}
          {selectedFile?.kind === "audio" && <audio src={selectedFile.previewUrl} controls />}
          {!selectedFile || !["image", "video", "audio"].includes(selectedFile.kind) ? <p>选择一个图像、视频或录音资源。</p> : null}
        </div>
      )}
    </aside>
  );
}

function VoiceButton({
  state,
  onStart,
  onStop
}: {
  state: VoiceState;
  onStart: () => void;
  onStop: () => void;
}) {
  const connecting = state === "connecting";
  const live = state === "live" || state === "thinking";
  const active = connecting || live;
  const label = live ? "断开语音" : connecting ? "正在连接，点击取消" : "开始语音";
  return (
    <button
      className={`voice-button ${connecting ? "connecting" : ""} ${live ? "live" : ""}`}
      onClick={active ? onStop : onStart}
      title={label}
      aria-label={label}
    >
      <Mic aria-hidden="true" />
    </button>
  );
}

function VoiceLevelBars({ state, inputLevel, outputLevel }: { state: VoiceState; inputLevel: number; outputLevel: number }) {
  const live = state === "live" || state === "thinking";
  const connecting = state === "connecting";
  const multipliers = [0.48, 0.68, 0.92, 0.76, 0.56, 0.82, 1, 0.62];
  const renderWave = (side: "user" | "ai", level: number) => (
    <div className={`voice-waveform ${side} ${connecting ? "connecting" : ""} ${live ? "live" : ""}`} aria-hidden="true">
      {multipliers.map((multiplier, index) => {
        const activeLevel = live ? level : 0;
        const height = 6 + Math.min(1, activeLevel * multiplier) * 40;
        return <span key={index} style={{ height: `${height}px`, opacity: live ? 0.36 + Math.min(1, activeLevel * 1.35 + 0.14) * 0.64 : 0.24 }} />;
      })}
    </div>
  );

  return (
    <>
      {renderWave("user", inputLevel)}
      {renderWave("ai", outputLevel)}
    </>
  );
}

function MicrophonePermissionWindow({
  denied,
  onRequest,
  onClose
}: {
  denied: boolean;
  onRequest: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="permission-window" role="dialog" aria-modal="true" aria-labelledby="mic-permission-title">
      <header className="permission-head">
        <div>
          <Mic size={20} />
          <strong id="mic-permission-title">开启麦克风权限</strong>
        </div>
        <button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button>
      </header>
      <p>
        {denied
          ? "当前浏览器已经拒绝了麦克风权限，所以再次点击按钮可能不会弹出系统授权窗口。"
          : "语音讨论需要访问麦克风。点击下方按钮后，浏览器会弹出系统授权窗口，请选择允许。"}
      </p>
      <p>
        如果之前拒绝过，需要在浏览器地址栏的站点设置中把麦克风改为允许；如果听不到声音，也请确认站点声音没有被静音。
      </p>
      {denied && (
        <p className="permission-warning">
          操作路径：地址栏左侧图标 → 网站设置 → 麦克风 → 允许，然后刷新页面。
        </p>
      )}
      <div className="permission-actions">
        <button className="secondary-button" onClick={onClose}>稍后</button>
        <button className="primary-button" onClick={onRequest}>{denied ? "重新检测权限" : "请求麦克风权限"}</button>
      </div>
    </aside>
  );
}

function ClearDiscussionConfirm({
  onConfirm,
  onClose
}: {
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="permission-window clear-confirm-window" role="dialog" aria-modal="true" aria-labelledby="clear-confirm-title">
      <header className="permission-head">
        <div>
          <Trash2 size={20} />
          <strong id="clear-confirm-title">清空当前讨论</strong>
        </div>
        <button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button>
      </header>
      <p>
        确认后会删除当前主题里的所有内容，包括主题文件、资源、临时文件、讨论方向、记录、要点和文字输入。
      </p>
      <p className="permission-warning">
        这个操作不可撤销；完成后当前主题会变成一个空白主题。
      </p>
      <div className="permission-actions">
        <button className="secondary-button" onClick={onClose}>取消</button>
        <button className="primary-button danger-button" onClick={onConfirm}>确认清空</button>
      </div>
    </aside>
  );
}

function GlassSelect({
  id,
  value,
  options,
  onChange
}: {
  id?: string;
  value: string;
  options: GlassSelectOption[];
  onChange: (_value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const chooseOption = (event: ReactMouseEvent<HTMLButtonElement>, nextValue: string) => {
    event.preventDefault();
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`glass-select ${open ? "open" : ""}`}>
      <button
        id={id}
        type="button"
        className="glass-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <span>{selectedOption?.label || "选择"}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="glass-select-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value || "default"}
              type="button"
              className={option.value === value ? "selected" : ""}
              role="option"
              aria-selected={option.value === value}
              onClick={(event) => chooseOption(event, option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SettingsPopover = forwardRef<HTMLElement, {
  settings: SettingsState;
  webEnabled: boolean;
  setWebEnabled: (_next: boolean) => void;
  audioInputDevices: MediaDeviceInfo[];
  selectedAudioInputId: string;
  setSelectedAudioInputId: (_next: string) => void;
  onRefreshAudioInputs: () => void;
  topics: DiscussionTopic[];
  activeTopicId: string;
  onImportTopic: (_topicId: string) => void;
  onDeleteTopic: (_topicId: string) => void;
  onSettingsSaved: (_settings: SettingsState) => void;
  onClose: () => void;
  style?: CSSProperties;
}>(function SettingsPopover({
  settings,
  webEnabled,
  setWebEnabled,
  audioInputDevices,
  selectedAudioInputId,
  setSelectedAudioInputId,
  onRefreshAudioInputs,
  topics,
  activeTopicId,
  onImportTopic,
  onDeleteTopic,
  onSettingsSaved,
  onClose,
  style
}, ref) {
  const [apiKey, setApiKey] = useState("");
  const [aiDraft, setAiDraft] = useState<AiSettings>(settings.ai);
  const wallpaperInputRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setAiDraft(settings.ai);
  }, [settings.ai]);

  const saveApiKey = async (nextKey = apiKey) => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/openai-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: nextKey })
      });
      if (!response.ok) throw new Error(await response.text());
      const nextSettings = await response.json();
      onSettingsSaved(nextSettings);
      setApiKey("");
      setMessage(nextKey.trim() ? "已保存" : "已清除");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveAiSettings = async (patch: Record<string, unknown> = {}) => {
    setSaving(true);
    setMessage("");
    try {
      const payload = { ...aiDraft, ...patch };
      const response = await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await response.text());
      const nextSettings = await response.json();
      onSettingsSaved(nextSettings);
      setAiDraft(nextSettings.ai);
      setMessage("AI 设定已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 设定保存失败");
    } finally {
      setSaving(false);
    }
  };

  const secretStatus = (configured?: boolean, source?: "local" | "env" | "none") => configured ? `已配置：${source}` : "未配置";

  const clearSearchKey = (secretName: string, fieldName: keyof AiSettings) => {
    void saveAiSettings({ clearWebSearchKeys: [secretName], [fieldName]: "" });
  };

  const uploadWallpaper = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setSaving(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("wallpaper", file);
      const response = await fetch("/api/settings/wallpaper", { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const nextSettings = await response.json();
      onSettingsSaved(nextSettings);
      setMessage("壁纸已更换");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "壁纸更换失败");
    } finally {
      setSaving(false);
      if (wallpaperInputRef.current) wallpaperInputRef.current.value = "";
    }
  };

  const resetWallpaper = async () => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/wallpaper", { method: "DELETE" });
      if (!response.ok) throw new Error(await response.text());
      const nextSettings = await response.json();
      onSettingsSaved(nextSettings);
      setMessage("已恢复默认壁纸");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside ref={ref} className="settings-popover" style={style}>
      <header className="settings-head">
        <strong>设置</strong>
        <div className="settings-head-actions">
          <span className={settings.openaiApiKeyConfigured ? "status-pill ready" : "status-pill"}>
            {settings.openaiApiKeyConfigured ? `Key: ${settings.openaiApiKeySource}` : "未配置 Key"}
          </span>
          <button type="button" className="settings-close-button" aria-label="关闭设置" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </header>

      <section className="settings-section">
        <label htmlFor="openai-api-key">OpenAI API Key</label>
        <div className="api-key-row">
          <input
            id="openai-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings.openaiApiKeyConfigured ? "输入新 Key 可替换" : "sk-..."}
            autoComplete="off"
          />
          <button disabled={saving || !apiKey.trim()} onClick={() => saveApiKey()}>
            保存
          </button>
        </div>
        <div className="settings-actions">
          <button disabled={saving || settings.openaiApiKeySource !== "local"} onClick={() => saveApiKey("")}>
            清除本地 Key
          </button>
          {message && <span>{message}</span>}
        </div>
        <p>
          {settings.openaiApiKeySource === "local"
            ? "当前优先使用设置页保存的 Key；清除本地 Key 后会回到 Render 的 OPENAI_API_KEY。"
            : settings.openaiApiKeySource === "env"
              ? "当前使用 Render 环境变量 OPENAI_API_KEY；在这里保存新 Key 会临时覆盖它。"
              : "未配置 Key。Render 环境变量和这里保存的 Key 二选一即可。"}
        </p>
      </section>

      <section className="settings-section ai-settings-section">
        <div className="settings-section-title">
          <strong>AI 设定</strong>
          <span>语音重连后生效</span>
        </div>
        <div className="ai-settings-grid">
          <label>
            名字
            <input
              value={aiDraft.assistantName}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, assistantName: event.target.value }))}
            />
          </label>
          <label>
            声音
            <GlassSelect
              value={aiDraft.realtimeVoice}
              options={["shimmer", "alloy", "ash", "ballad", "coral", "echo", "sage", "verse"].map((voice) => ({ value: voice, label: voice }))}
              onChange={(value) => setAiDraft((draft) => ({ ...draft, realtimeVoice: value }))}
            />
          </label>
          <label>
            语音模型
            <GlassSelect
              value={aiDraft.realtimeModel}
              options={[
                { value: "gpt-realtime-2", label: "gpt-realtime-2" },
                { value: "gpt-realtime", label: "gpt-realtime" }
              ]}
              onChange={(value) => setAiDraft((draft) => ({ ...draft, realtimeModel: value }))}
            />
          </label>
          <label>
            转写模型
            <GlassSelect
              value={aiDraft.transcriptionModel}
              options={[
                { value: "gpt-4o-transcribe", label: "gpt-4o-transcribe" },
                { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe" }
              ]}
              onChange={(value) => setAiDraft((draft) => ({ ...draft, transcriptionModel: value }))}
            />
          </label>
          <label>
            图片模型
            <GlassSelect
              value={aiDraft.imageModel}
              options={[
                { value: "gpt-image-1.5", label: "gpt-image-1.5" },
                { value: "gpt-image-1", label: "gpt-image-1" }
              ]}
              onChange={(value) => setAiDraft((draft) => ({ ...draft, imageModel: value }))}
            />
          </label>
          <label>
            图片质量
            <GlassSelect
              value={aiDraft.imageQuality}
              options={[
                { value: "high", label: "high" },
                { value: "auto", label: "auto" },
                { value: "medium", label: "medium" },
                { value: "low", label: "low" }
              ]}
              onChange={(value) => setAiDraft((draft) => ({ ...draft, imageQuality: value as AiSettings["imageQuality"] }))}
            />
          </label>
          <label className="wide">
            搜索提供方顺序
            <input
              value={aiDraft.webSearchProviders}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, webSearchProviders: event.target.value }))}
              placeholder="openai,brave,bing,google,serpapi,tavily,duckduckgo,wikipedia"
            />
          </label>
        </div>

        <div className="settings-section-title search-settings-title">
          <strong>搜索 API Key</strong>
          <span>留空不变，输入可替换</span>
        </div>
        <div className="ai-settings-grid search-key-grid">
          <label>
            Brave
            <input
              type="password"
              value={aiDraft.braveSearchApiKey || ""}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, braveSearchApiKey: event.target.value }))}
              placeholder={secretStatus(aiDraft.braveSearchApiKeyConfigured, aiDraft.braveSearchApiKeySource)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={saving || aiDraft.braveSearchApiKeySource !== "local"}
              onClick={() => clearSearchKey("brave", "braveSearchApiKey")}
            >
              清除
            </button>
          </label>
          <label>
            Bing
            <input
              type="password"
              value={aiDraft.bingSearchApiKey || ""}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, bingSearchApiKey: event.target.value }))}
              placeholder={secretStatus(aiDraft.bingSearchApiKeyConfigured, aiDraft.bingSearchApiKeySource)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={saving || aiDraft.bingSearchApiKeySource !== "local"}
              onClick={() => clearSearchKey("bing", "bingSearchApiKey")}
            >
              清除
            </button>
          </label>
          <label>
            Google API Key
            <input
              type="password"
              value={aiDraft.googleSearchApiKey || ""}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, googleSearchApiKey: event.target.value }))}
              placeholder={secretStatus(aiDraft.googleSearchApiKeyConfigured, aiDraft.googleSearchApiKeySource)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={saving || aiDraft.googleSearchApiKeySource !== "local"}
              onClick={() => clearSearchKey("google", "googleSearchApiKey")}
            >
              清除
            </button>
          </label>
          <label>
            Google Engine ID
            <input
              type="password"
              value={aiDraft.googleSearchEngineId || ""}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, googleSearchEngineId: event.target.value }))}
              placeholder={secretStatus(aiDraft.googleSearchEngineIdConfigured, aiDraft.googleSearchEngineIdSource)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={saving || aiDraft.googleSearchEngineIdSource !== "local"}
              onClick={() => clearSearchKey("googleEngine", "googleSearchEngineId")}
            >
              清除
            </button>
          </label>
          <label>
            SerpAPI
            <input
              type="password"
              value={aiDraft.serpApiKey || ""}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, serpApiKey: event.target.value }))}
              placeholder={secretStatus(aiDraft.serpApiKeyConfigured, aiDraft.serpApiKeySource)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={saving || aiDraft.serpApiKeySource !== "local"}
              onClick={() => clearSearchKey("serpapi", "serpApiKey")}
            >
              清除
            </button>
          </label>
          <label>
            Tavily
            <input
              type="password"
              value={aiDraft.tavilyApiKey || ""}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, tavilyApiKey: event.target.value }))}
              placeholder={secretStatus(aiDraft.tavilyApiKeyConfigured, aiDraft.tavilyApiKeySource)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={saving || aiDraft.tavilyApiKeySource !== "local"}
              onClick={() => clearSearchKey("tavily", "tavilyApiKey")}
            >
              清除
            </button>
          </label>
        </div>
        <div className="settings-actions">
          <button disabled={saving} onClick={() => saveAiSettings()}>保存 AI 设定</button>
        </div>
      </section>

      <section className="settings-section">
        <label htmlFor="audio-input-device">输入设备</label>
        <div className="device-row">
          <GlassSelect
            id="audio-input-device"
            value={selectedAudioInputId}
            options={[
              { value: "", label: "系统默认麦克风" },
              ...audioInputDevices.map((device, index) => ({
                value: device.deviceId,
                label: device.label || `麦克风 ${index + 1}`
              }))
            ]}
            onChange={setSelectedAudioInputId}
          />
          <button type="button" onClick={onRefreshAudioInputs}>刷新</button>
        </div>
        <p>{audioInputDevices.length ? "语音讨论会使用这里选择的输入设备。" : "授权麦克风后可显示完整设备名称。"}</p>
      </section>

      <section className="settings-section compact">
        <div>
          <strong>Web</strong>
          <button className={webEnabled ? "toggle enabled" : "toggle"} onClick={() => setWebEnabled(!webEnabled)}>
            <span />
          </button>
        </div>
        <p>AI 可按需查阅互联网，但回答必须回到当前主题。</p>
      </section>

      <section className="settings-section">
        <details className="topic-import">
          <summary>导入历史讨论话题</summary>
          <div className="topic-import-list">
            {topics.length ? (
              topics.map((topic) => (
                <div key={topic.id} className={topic.id === activeTopicId ? "topic-import-row active" : "topic-import-row"}>
                  <button type="button" onClick={() => onImportTopic(topic.id)} disabled={topic.id === activeTopicId}>
                    <strong>{topic.title}</strong>
                    <span>{topic.fileCount} 文件 · {topic.recordCount} 记录</span>
                  </button>
                  <button type="button" className="topic-delete-button" onClick={() => onDeleteTopic(topic.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            ) : (
              <p>暂无历史话题。</p>
            )}
          </div>
        </details>
      </section>

      <section className="settings-section">
        <label>壁纸</label>
        <input
          ref={wallpaperInputRef}
          hidden
          type="file"
          accept="image/*"
          onChange={(event) => uploadWallpaper(event.target.files)}
        />
        <div className="wallpaper-row">
          <button disabled={saving} onClick={() => wallpaperInputRef.current?.click()}>
            更换壁纸
          </button>
          <button disabled={saving || !settings.wallpaperUrl} onClick={resetWallpaper}>
            恢复默认
          </button>
        </div>
        <p>{settings.wallpaperUrl ? "当前使用自定义壁纸。" : "当前使用默认壁纸。"}</p>
      </section>
    </aside>
  );
});

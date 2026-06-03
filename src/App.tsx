import {
  ChartNoAxesColumn,
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
      responseLength: "short",
      responseTone: "活泼、简洁、有一点笑意",
      visualStyle: "清晰、精致、可用于讨论"
    }
  }
};
type TopicProposal = { title: string; reason: string; intent: "confirm" | "drift" };
type DirectionProposal = { directions: string[]; reason: string };
type SettingsState = NonNullable<AppState["settings"]>;
type VoiceState = "idle" | "connecting" | "live" | "thinking" | "error";
type WebPreview = { url: string; title: string };
type PanelId = "topic" | "resources" | "generated" | "record";
type ToolId = "whiteboard" | "draft" | "image" | "video" | "audio";
type StatusLogEntry = { id: string; kind: "status" | "error"; text: string; createdAt: string };
type TaskItem = { id: string; label: string; startedAt: string };
type ToolActivity = { id: string; label: string; status: "running" | "done" | "failed" | "cancelled"; startedAt: string; endedAt?: string; detail?: string; result?: string };
type RealtimeToolCall = { name?: string; arguments?: string; call_id?: string };
type BoardItem = { id: string; kind: "text" | "image"; value: string; x: number; y: number };
type BoardLink = { id: string; from: string; to: string };
type DiscussionContract = { goal: string; boundaries: string[]; outputFormat: string; responseLength: "short" | "medium" | "long"; updatedAt: string };
type DiscussionAgendaItem = { title: string; objective: string; output: string; status: "pending" | "active" | "done" };
type ResponseScope = { maxSentences: number; onePointOnly: boolean; mustAskFirst: boolean };
type CognitiveLoad = "simple" | "normal" | "detailed" | "step_by_step";
const fileDragType = "application/x-discuz-file-id";
type AudioContextConstructor = typeof AudioContext;
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
  const noiseFloor = 0.018;
  if (rms <= noiseFloor) return 0;
  const normalized = Math.min(1, (rms - noiseFloor) / 0.18);
  return Math.pow(normalized, 0.72);
}

function voiceStartErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const name = error instanceof DOMException ? error.name : "";
  if (isVoicePermissionError(error)) {
    return "麦克风权限被拒绝。请在浏览器地址栏或站点设置中允许 localhost 使用麦克风，并确认系统设置允许当前浏览器使用麦克风，然后刷新页面再试。";
  }
  if (name === "NotFoundError" || /requested device not found|no.*microphone|not found/i.test(message)) {
    return "没有找到可用麦克风。请连接或启用麦克风后再试。";
  }
  if (name === "NotReadableError" || /could not start|not readable|in use/i.test(message)) {
    return "麦克风暂时不可用，可能被其他应用占用。请关闭占用麦克风的应用后再试。";
  }
  return message || "无法启动语音。";
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
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, Math.min(36, rect.width / 2), Math.min(28, rect.height / 2));
  window.setTimeout(() => ghost.remove(), 0);
}

function toolCallLabel(name = "任务") {
  return ({
    search_context: "检索本地材料",
    web_search: "联网搜索",
    open_web_page: "打开网页",
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
    edit_spreadsheet_file: "编辑表格请求",
    create_outline: "生成大纲",
    compare_files: "比较文件",
    extract_action_items: "提取行动项",
    create_table_summary: "生成表格总结",
    export_discussion_record: "导出讨论记录",
    download_file: "下载文件",
    create_diagram: "生成图表",
    schedule_followup: "安排跟进",
    set_response_style: "设置回答风格",
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
    copy_file_to_generated: "复制到临时区",
    add_file_to_topic: "加入主题区",
    move_file_to_area: "移动文件",
    update_generated_file: "更新临时文案",
    generate_image: "生成图片",
    propose_discussion_directions: "建议讨论方向",
    update_discussion_directions: "更新讨论方向",
    complete_discussion_direction: "完成讨论方向",
    propose_discussion_topic: "确认讨论主题"
  } as Record<string, string>)[name] || name;
}

type OfficeAnalysisKind = "word" | "spreadsheet" | "presentation";

function selectOfficeFile(files: DiscuzFile[], kind: OfficeAnalysisKind, role?: DiscuzFile["role"], query = "") {
  const queryText = query.trim().toLowerCase();
  const allowedKinds: Record<OfficeAnalysisKind, DiscuzFile["kind"][]> = {
    word: ["doc", "docx"],
    spreadsheet: ["spreadsheet"],
    presentation: ["pptx"]
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

function compactText(value: string, maxChars = 18000) {
  const text = value.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n... 已截断，以上为前 ${maxChars} 字。` : text;
}

function buildWordAnalysisPayload(file: DiscuzFile, focus: string) {
  const paragraphs = file.extractedText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const possibleHeadings = paragraphs.filter((line) => line.length <= 80 && !/[。！？!?；;]$/.test(line)).slice(0, 12);
  return {
    ok: true,
    mode: "word",
    file: { id: file.id, name: file.originalName, role: file.role, kind: file.kind, summary: file.summary },
    focus,
    structure: {
      paragraphCount: paragraphs.length,
      possibleHeadings,
      openingParagraphs: paragraphs.slice(0, 8)
    },
    instructions: [
      "Use the Documents skill discussion bridge: review structure, argument, clarity, gaps, risks, and possible edits.",
      "Do not claim visual DOCX layout verification unless a separate render-and-review workflow is run."
    ],
    content: compactText(file.extractedText || file.summary || "")
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
      firstRows: dataRows.slice(0, 12),
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
      sheets
    },
    instructions: [
      "Use the Spreadsheets skill discussion bridge: inspect sheets, fields, row patterns, formulas if visible, anomalies, trends, missing columns, and next analysis steps.",
      "If exact calculations are needed, ask the user to confirm the target sheet/range or request a generated analysis workbook."
    ],
    content: compactText(file.extractedText || file.summary || "")
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
        text: lines.slice(1, 12)
      };
    });
  return {
    ok: true,
    mode: "presentation",
    file: { id: file.id, name: file.originalName, role: file.role, kind: file.kind, summary: file.summary },
    focus,
    structure: {
      slideCount: slides.length,
      slides: slides.slice(0, 30)
    },
    instructions: [
      "Use the Presentations skill discussion bridge: review narrative spine, slide claims, proof objects, flow, audience fit, missing evidence, and improvement opportunities.",
      "Do not claim visual slide QA unless the deck is rendered and inspected separately."
    ],
    content: compactText(file.extractedText || file.summary || "")
  };
}

function fileBrief(file: DiscuzFile) {
  return {
    id: file.id,
    name: file.originalName,
    role: file.role,
    kind: file.kind,
    summary: file.summary,
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
  if (file.kind === "pptx") return "后台解析PPT";
  if (file.kind === "doc" || file.kind === "docx") return "后台解析Word";
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
  const [voiceLevel, setVoiceLevel] = useState(0);
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const statusLogRef = useRef<HTMLDivElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const handleToolCallRef = useRef<((_message: RealtimeToolCall) => Promise<void>) | null>(null);
  const responseActiveRef = useRef(false);
  const responsePendingRef = useRef(false);
  const topicFileChangeBlocksTopicProposalRef = useRef(false);
  const voiceSessionRef = useRef(0);
  const voiceSessionStartedAtRef = useRef<string | null>(null);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const voiceMeterRef = useRef<VoiceMeter | null>(null);
  const pendingTaskCountRef = useRef(0);
  const activeTaskLabelRef = useRef("");
  const backgroundParsingActiveRef = useRef(false);
  const assistantRespondedSinceUserRef = useRef(true);
  const lastLocalAckAtRef = useRef(0);
  const lastStatusLogRef = useRef("Ready");
  const lastErrorLogRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const userTranscriptRef = useRef("");
  const boardRef = useRef<HTMLDivElement | null>(null);
  const recordStreamRef = useRef<HTMLDivElement | null>(null);

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
  const visibleTasks = useMemo(
    () => [...backgroundParsingTasks, ...pendingTasks].slice(-6),
    [backgroundParsingTasks, pendingTasks]
  );
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

  const loadState = useCallback(async () => {
    const response = await fetch("/api/state");
    const nextState = await response.json();
    setState(nextState);
    if (!selectedId) {
      const primary = nextState.files.find((file: DiscuzFile) => file.role === "primary");
      setSelectedId(primary?.id ?? nextState.files[0]?.id ?? null);
    }
  }, [selectedId]);

  useEffect(() => {
    loadState().catch((err) => setError(err.message));
  }, [loadState]);

  useEffect(() => {
    if (!hasParsingFiles) return;
    const timer = window.setInterval(() => {
      loadState().catch((err) => setError(err.message));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasParsingFiles, loadState]);

  useEffect(() => {
    if (parsingFiles.length) {
      backgroundParsingActiveRef.current = true;
      const label = parsingFiles.length === 1 ? fileExtractionLabel(parsingFiles[0]) : `后台解析/识别 ${parsingFiles.length} 个文件`;
      if (pendingTaskCountRef.current === 0) setStatusText(`AI正在执行：${label}，请稍等`);
      return;
    }
    if (backgroundParsingActiveRef.current) {
      backgroundParsingActiveRef.current = false;
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
    const physicalWidth = Math.min(360 * scale, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.right - physicalWidth), window.innerWidth - physicalWidth - 12);
    const top = Math.min(rect.bottom + 8 * scale, window.innerHeight - 24);
    setSettingsPopoverStyle({
      left: left / scale,
      right: "auto",
      top: top / scale
    });
  }, [layoutScale]);

  const toggleSettingsPopover = () => {
    if (!settingsOpen) positionSettingsPopover();
    setSettingsOpen((value) => !value);
  };

  useEffect(() => {
    if (settingsOpen) positionSettingsPopover();
  }, [layoutScale, positionSettingsPopover, settingsOpen]);

  useEffect(() => {
    if (recordStreamRef.current) {
      recordStreamRef.current.scrollTop = recordStreamRef.current.scrollHeight;
    }
  }, [state.meetingMessages.length]);

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
    pendingTaskCountRef.current += 1;
    activeTaskLabelRef.current = label;
    setPendingTasks((current) => [...current, { id, label, startedAt }].slice(-6));
    setStatusText(`AI正在执行：${label}，请稍等`);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pendingTaskCountRef.current = Math.max(0, pendingTaskCountRef.current - 1);
      setPendingTasks((current) => current.filter((task) => task.id !== id));
      if (pendingTaskCountRef.current > 0) {
        setStatusText(`AI正在执行：${activeTaskLabelRef.current || "任务"}，请稍等`);
      } else {
        activeTaskLabelRef.current = "";
        setStatusText(`${label}完成`);
      }
    };
  }, []);

  const acknowledgeImmediately = useCallback((text: string, speak = false) => {
    const clean = text.trim();
    if (!clean) return;
    setStatusText(clean);
    if (!speak || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
    const nowMs = Date.now();
    if (nowMs - lastLocalAckAtRef.current < 1200) return;
    lastLocalAckAtRef.current = nowMs;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = "zh-CN";
    utterance.rate = 1.08;
    utterance.pitch = 1.08;
    window.speechSynthesis.speak(utterance);
  }, []);

  const summarizeToolResult = (value: unknown) => {
    const result = value as Record<string, unknown>;
    if (result?.error) return String(result.error);
    if (result?.opened) return `已打开：${String(result.opened)}`;
    if (result?.generated) return `已生成：${String(result.generated)}`;
    if (result?.downloaded) return `已下载：${String(result.downloaded)}`;
    if (result?.saved) return `已保存：${String(result.saved)}`;
    if (result?.analysis) return compactText(String(result.analysis), 120);
    if (result?.paused) return "已暂停等待";
    if (result?.breakUntil) return "休息计时已开始";
    return compactText(JSON.stringify(value), 140);
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
    return id;
  };

  const updateToolActivity = (id: string, patch: Partial<ToolActivity>) => {
    setToolActivities((items) => items.map((item) => item.id === id ? { ...item, ...patch, endedAt: patch.endedAt ?? item.endedAt } : item));
  };

  const setPrimary = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const finishTask = beginTask("上传主题文件");
    try {
      const payload = await uploadFiles("/api/files/primary", "files", list);
      setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
      setSelectedId(payload.uploaded?.[0]?.id ?? payload.file?.id ?? selectedId);
      notifyPrimaryFilesAdded((payload.uploaded ?? (payload.file ? [payload.file] : [])) as DiscuzFile[]);
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
      setSelectedId(file.id);
      setGeneratedEditorId(null);
      notifyPrimaryFilesAdded(payload.file ? [payload.file as DiscuzFile] : [file]);
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
      setSelectedId(file.id);
      if (role !== "generated") setGeneratedEditorId(null);
      if (previewFileId === file.id && role === "generated") setPreviewFileId(null);
      if (role === "primary") notifyPrimaryFilesAdded(payload.file ? [payload.file as DiscuzFile] : [file]);
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
      setError("");
      return payload.file as DiscuzFile;
    } finally {
      finishTask();
    }
  };

  const requestRealtimeResponse = useCallback(() => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") return false;
    if (responseActiveRef.current) {
      responsePendingRef.current = true;
      setStatusText("AI仍在处理上一轮，稍等");
      return false;
    }
    responseActiveRef.current = true;
    responsePendingRef.current = false;
    channel.send(JSON.stringify({ type: "response.create" }));
    return true;
  }, []);

  const sendRealtimeSystemEvent = (text: string, options: { blockTopicProposal?: boolean } = {}) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") return false;
    if (options.blockTopicProposal) {
      topicFileChangeBlocksTopicProposalRef.current = true;
      window.setTimeout(() => {
        topicFileChangeBlocksTopicProposalRef.current = false;
      }, 18000);
    }
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }]
      }
    }));
    return requestRealtimeResponse();
  };

  const flushRealtimeResponse = useCallback(() => {
    if (!responsePendingRef.current) return;
    requestRealtimeResponse();
  }, [requestRealtimeResponse]);

  const notifyForegroundDiscussion = (title: string, text: string) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `系统事件：用户打开了前台讨论窗口《${title}》。这个窗口现在是当前临时讨论对象，请先阅读以下内容，再围绕它继续讨论。\n\n${text.slice(0, 6000)}`
        }]
      }
    }));
    requestRealtimeResponse();
  };

  const describeFileForDiscussion = (file: DiscuzFile) => {
    return [
      `文件名：${file.originalName}`,
      `区域：${file.role}`,
      `类型：${file.kind}`,
      file.extractedText ? `内容：\n${file.extractedText}` : `摘要：${file.summary || "无可读文本"}`,
      file.previewUrl ? `预览地址：${file.previewUrl}` : ""
    ].filter(Boolean).join("\n\n");
  };

  const primaryFileChangeNames = (files: DiscuzFile[]) => files.map((file) => `《${file.originalName}》`).join("、");

  const notifyPrimaryFilesAdded = (files: DiscuzFile[]) => {
    if (!files.length) return;
    sendRealtimeSystemEvent(
      [
        `系统事件：用户刚刚在主题区添加了主题文件：${primaryFileChangeNames(files)}。`,
        "请立即用 1 句中文询问用户接下来想怎么讨论，例如先看哪份、想解决什么问题或是否需要你先粗看一遍。",
        "重要约束：不要调用 propose_discussion_topic、propose_discussion_directions 或 update_discussion_directions；不要修改、重命名、清空或重新确认当前讨论主题；除非用户下一句明确要求修改主题或重新确认主题。"
      ].join("\n"),
      { blockTopicProposal: true }
    );
  };

  const notifyPrimaryFileDeleted = (file: DiscuzFile) => {
    sendRealtimeSystemEvent(
      [
        `系统事件：用户刚刚从主题区删除了主题文件《${file.originalName}》。`,
        "请立即用 1 句中文询问用户下一步要继续用剩余主题文件讨论、上传新的主题文件，还是暂停这个主题。",
        "重要约束：不要调用 propose_discussion_topic、propose_discussion_directions 或 update_discussion_directions；不要修改、重命名、清空或重新确认当前讨论主题；除非用户下一句明确要求修改主题或重新确认主题。"
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
      assistantRespondedSinceUserRef.current = false;
      acknowledgeImmediately("收到，我在处理。");
      saveMeetingMessage(text, "user").catch((err) => setError(err instanceof Error ? err.message : "Unable to save meeting record"));

      const channel = dataChannelRef.current;
      if (channel?.readyState === "open") {
        channel.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `用户文字输入：${text}` }]
          }
        }));
        requestRealtimeResponse();
        setStatusText("收到，我在处理。");
      } else {
        setStatusText("Saved for next discussion");
      }
    } finally {
      finishTask();
    }
  };

  const confirmDiscussionTopic = async (title: string) => {
    const response = await fetch("/api/discussion-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: title })
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
    setDirectionProposal(null);
    const channel = dataChannelRef.current;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `系统事件：用户已确认讨论主题《${title}》。请立即基于当前主题、主题文件和用户输入调用 propose_discussion_directions，提出 3 到 5 个讨论方向供用户确认。语音只简单说“我先列几个方向，你看要不要删改”。如果用户不满意，优先调用 update_discussion_directions 快速替换完整列表；如果用户只是不想要某一条，提醒他可以直接点圆圈右侧删除。`
          }]
        }
      }));
      requestRealtimeResponse();
    }
  };

  const confirmDirectionProposal = async (directions: string[]) => {
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
  };

  const completeDirection = async (direction: DiscussionDirection, note = "") => {
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
    dataChannelRef.current?.send(JSON.stringify({ type: "response.cancel" }));
    responseActiveRef.current = false;
    responsePendingRef.current = false;
    pendingTaskCountRef.current = 0;
    activeTaskLabelRef.current = "";
    setPendingTasks([]);
    setToolActivities((items) => items.map((item) => item.status === "running" ? { ...item, status: "cancelled", endedAt: new Date().toISOString(), result: "用户取消" } : item));
    setStatusText("已取消当前任务");
  }, []);

  const handleToolCall = async (message: RealtimeToolCall) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open" || !message.call_id || !message.name) return;
    const args = JSON.parse(message.arguments || "{}");
    const label = toolCallLabel(message.name);
    if (!assistantRespondedSinceUserRef.current) {
      acknowledgeImmediately(`我在执行${label}，稍等。`, true);
      assistantRespondedSinceUserRef.current = true;
    }
    const activityId = createToolActivity(label, message.name);
    const finishTask = beginTask(label);
    let output = {};
    try {
      if (message.name === "search_context") {
        const response = await fetch(`/api/context/search?q=${encodeURIComponent(args.query || "")}`);
        output = await response.json();
      }
      if (message.name === "web_search") {
        if (!webEnabled) output = { error: "Web search is disabled by the user." };
        else {
          const response = await fetch(`/api/web/search?q=${encodeURIComponent(args.query || "")}`);
          output = await response.json();
        }
      }
      if (message.name === "open_web_page") {
        const rawUrl = String(args.url || "").trim();
        const url = rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol");
          setWebPreview({ url: parsed.toString(), title: String(args.title || parsed.hostname || "网页").trim() });
          setActiveTool(null);
          setPreviewFileId(null);
          setPreviewRecordId(null);
          setGeneratedEditorId(null);
          output = { ok: true, opened: parsed.toString() };
        } catch {
          output = { ok: false, error: "Invalid web URL. Use an http or https URL." };
        }
      }
      if (message.name === "set_layout") {
        applyLayoutCommand(args.target || "reset", args.mode || "reset");
        output = { ok: true, layout: args };
      }
      if (message.name === "open_discussion_tool") {
        const tool = (args.tool || "whiteboard") as ToolId;
        openToolDiscussionWindow(tool);
        output = { ok: true, opened: args.tool };
      }
      if (message.name === "save_discussion_tool") {
        const tool = (args.tool === "whiteboard" || args.tool === "draft" ? args.tool : activeTool) as ToolId | null;
        if (tool === "whiteboard" || tool === "draft") {
          await saveToolToGenerated(tool);
          output = { ok: true, saved: tool };
        } else {
          output = { ok: false, error: "No savable tool is open." };
        }
      }
      if (message.name === "clear_discussion_tool") {
        const tool = (args.tool === "whiteboard" || args.tool === "draft" ? args.tool : activeTool) as ToolId | null;
        if (tool === "whiteboard" || tool === "draft") {
          clearToolContent(tool);
          output = { ok: true, cleared: tool };
        } else {
          output = { ok: false, error: "No clearable tool is open." };
        }
      }
      if (message.name === "close_foreground_window") {
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
      if (message.name === "open_file_preview") {
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
      if (message.name === "analyze_word_file" || message.name === "analyze_spreadsheet_file" || message.name === "analyze_presentation_file") {
        const role = args.role === "primary" || args.role === "context" || args.role === "generated" ? args.role as DiscuzFile["role"] : undefined;
        const queryText = String(args.query || "").trim();
        const focus = String(args.focus || "").trim();
        const analysisKind: OfficeAnalysisKind =
          message.name === "analyze_word_file" ? "word" :
            message.name === "analyze_spreadsheet_file" ? "spreadsheet" :
              "presentation";
        const candidate = selectOfficeFile(state.files, analysisKind, role, queryText);
        if (!candidate) {
          output = {
            ok: false,
            error: `No matching ${analysisKind} file found. Ask the user to upload one or specify the filename.`
          };
        } else if (analysisKind === "word") {
          output = buildWordAnalysisPayload(candidate, focus);
        } else if (analysisKind === "spreadsheet") {
          output = buildSpreadsheetAnalysisPayload(candidate, focus);
        } else {
          output = buildPresentationAnalysisPayload(candidate, focus);
        }
      }
      if (message.name === "analyze_image_file") {
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
            analysis: payload.file?.extractedText || candidate.extractedText || candidate.summary
          };
        }
      }
      if (message.name === "read_current_focus") {
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
      if (message.name === "get_discussion_state") {
        output = {
          ok: true,
          topic: state.discussionTopic,
          activeTopicId: state.activeTopicId,
          files: state.files.map(fileBrief),
          directions: state.directions,
          notes: state.notes.slice(-20),
          meetingMessages: state.meetingMessages.slice(-40),
          records: state.records.slice(-10),
          pendingTasks,
          statusText,
          foreground: { activeTool, previewFile: previewFile ? fileBrief(previewFile) : null, webPreview },
          governance: {
            discussionContract,
            discussionAgenda,
            agendaLocked,
            currentAgendaIndex,
            responseScope,
            userCognitiveLoad,
            outputRubric
          }
        };
      }
      if (message.name === "ask_user_confirmation") {
        const prompt = String(args.prompt || "").trim();
        const options = normalizeLines(args.options).slice(0, 4);
        setStatusText(prompt ? `等待用户确认：${prompt}` : "等待用户确认");
        output = { ok: true, needsConfirmation: true, prompt, options };
      }
      if (message.name === "queue_task") {
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
      if (message.name === "start_break") {
        const minutes = Math.max(1, Math.min(30, Number(args.minutes || args.durationMinutes || 5)));
        const until = new Date(Date.now() + minutes * 60000).toISOString();
        setBreakUntil(until);
        setAmbientMode(args.ambientMode === true ? true : ambientMode);
        setStatusText(`休息中 ${minutes}:00`);
        output = { ok: true, breakUntil: until, minutes };
      }
      if (message.name === "resume_discussion") {
        setBreakUntil(null);
        setAmbientMode(false);
        setStatusText("已回到讨论");
        output = { ok: true, resumed: true };
      }
      if (message.name === "open_media_url") {
        const rawUrl = String(args.url || "").trim();
        const url = rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol");
          const mediaType = String(args.mediaType || "media").trim();
          setWebPreview({ url: parsed.toString(), title: String(args.title || (mediaType === "music" ? "在线音乐" : mediaType === "video" ? "视频" : "媒体")).trim() });
          setStatusText("媒体窗口已打开");
          output = { ok: true, opened: parsed.toString(), mediaType };
        } catch {
          output = { ok: false, error: "Invalid media URL. Use an http or https URL." };
        }
      }
      if (message.name === "set_ambient_mode") {
        const enabled = args.enabled !== false;
        setAmbientMode(enabled);
        const musicUrl = String(args.musicUrl || "").trim();
        if (enabled && musicUrl) {
          const url = /^https?:\/\//i.test(musicUrl) ? musicUrl : `https://${musicUrl}`;
          setWebPreview({ url, title: String(args.title || "氛围音乐").trim() });
        }
        setStatusText(enabled ? "氛围模式已开启" : "氛围模式已关闭");
        output = { ok: true, ambientMode: enabled, musicUrl: musicUrl || "" };
      }
      if (message.name === "show_tool_activity") {
        output = { ok: true, activities: toolActivities.slice(0, 8) };
      }
      if (message.name === "cancel_current_task") {
        cancelCurrentTask();
        output = { ok: true, cancelled: true };
      }
      if (message.name === "edit_spreadsheet_file") {
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
              compactText(candidate.extractedText || candidate.summary || "", 12000)
            ].join("\n")
          );
          output = { ok: true, generated: file.originalName, sourceFile: fileBrief(candidate) };
        }
      }
      if (message.name === "create_outline") {
        const title = String(args.title || "讨论大纲.md").trim();
        const sections = normalizeLines(args.sections);
        const text = String(args.text || "").trim() || sections.map((section, index) => `${index + 1}. ${section}`).join("\n");
        if (!text) output = { ok: false, error: "Missing outline content." };
        else {
          const file = await createGeneratedFile(title, `# ${title.replace(/\.md$/i, "")}\n\n${text}`);
          output = { ok: true, generated: file.originalName };
        }
      }
      if (message.name === "compare_files") {
        const firstRole = args.firstRole === "primary" || args.firstRole === "context" || args.firstRole === "generated" ? args.firstRole as DiscuzFile["role"] : undefined;
        const secondRole = args.secondRole === "primary" || args.secondRole === "context" || args.secondRole === "generated" ? args.secondRole as DiscuzFile["role"] : undefined;
        const first = selectFileByQuery(state.files, String(args.firstQuery || ""), firstRole, undefined);
        const second = selectFileByQuery(state.files, String(args.secondQuery || ""), secondRole, undefined);
        if (!first || !second) {
          output = { ok: false, error: "Need two matching files to compare." };
        } else {
          output = {
            ok: true,
            files: [fileBrief(first), fileBrief(second)],
            firstContent: compactText(first.extractedText || first.summary || "", 10000),
            secondContent: compactText(second.extractedText || second.summary || "", 10000),
            instruction: "Compare these two files and summarize differences, risks, and suggested next edits."
          };
        }
      }
      if (message.name === "extract_action_items") {
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
      if (message.name === "create_table_summary") {
        const headers = normalizeLines(args.headers).slice(0, 8);
        const rows = (Array.isArray(args.rows) ? args.rows : []).map((row: unknown) => Array.isArray(row) ? row.map((cell) => String(cell || "")) : []);
        const title = String(args.title || "讨论表格总结.md").trim();
        if (!headers.length || !rows.length) output = { ok: false, error: "Missing table headers or rows." };
        else {
          const file = await createGeneratedFile(title, `# ${title.replace(/\.md$/i, "")}\n\n${markdownTable(headers, rows)}`);
          output = { ok: true, generated: file.originalName, rows: rows.length };
        }
      }
      if (message.name === "export_discussion_record") {
        const title = String(args.title || `讨论记录-${shortTime(new Date().toISOString()).replace(":", "-")}.md`).trim();
        const file = await createGeneratedFile(title, buildDiscussionRecordMarkdown(title));
        output = { ok: true, generated: file.originalName };
      }
      if (message.name === "download_file") {
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
      if (message.name === "create_diagram") {
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
      if (message.name === "schedule_followup") {
        const title = String(args.title || "后续跟进").trim();
        const when = String(args.when || "").trim();
        const detail = String(args.detail || "").trim();
        await saveNote(`${title}${when ? `｜时间：${when}` : ""}${detail ? `｜${detail}` : ""}`, "action", "AI follow-up");
        output = { ok: true, scheduled: title, when, detail, noteSaved: true };
      }
      if (message.name === "set_response_style") {
        const length = ["short", "medium", "long"].includes(args.length) ? args.length : "short";
        const tone = String(args.tone || "活泼、简洁").trim();
        const askFirst = args.askFirst !== false;
        localStorage.setItem("discuz-response-style", JSON.stringify({ length, tone, askFirst }));
        output = { ok: true, style: { length, tone, askFirst }, note: "Style is saved locally and should be followed by the assistant in future responses." };
      }
      if (message.name === "set_discussion_contract") {
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
      if (message.name === "check_topic_alignment") {
        const aligned = args.aligned !== false;
        const score = Math.max(0, Math.min(100, Number(args.score ?? (aligned ? 90 : 45))));
        const issue = String(args.issue || "").trim();
        const recommendation = String(args.recommendation || "").trim();
        if (!aligned || score < 70) setStatusText(`主题偏离提醒：${recommendation || issue || "请回到当前主题"}`);
        output = { ok: true, aligned, score, issue, recommendation, topic: state.discussionTopic };
      }
      if (message.name === "advance_discussion_step") {
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
      if (message.name === "mark_uncertainty") {
        const text = String(args.text || "").trim();
        const reason = String(args.reason || "").trim();
        const needed = normalizeLines(args.needed).slice(0, 5);
        if (!text) output = { ok: false, error: "Missing uncertainty text." };
        else {
          await saveNote(`不确定：${text}${reason ? `；原因：${reason}` : ""}${needed.length ? `；需要补充：${needed.join("、")}` : ""}`, "question", "Uncertainty");
          output = { ok: true, text, reason, needed };
        }
      }
      if (message.name === "limit_response_scope") {
        const maxSentences = Math.max(1, Math.min(8, Number(args.maxSentences || 2)));
        const onePointOnly = args.onePointOnly !== false;
        const mustAskFirst = args.mustAskFirst === true;
        const scope = { maxSentences, onePointOnly, mustAskFirst };
        setResponseScope(scope);
        output = { ok: true, scope };
      }
      if (message.name === "create_discussion_agenda") {
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
      if (message.name === "lock_discussion_agenda") {
        setAgendaLocked(true);
        const reason = String(args.reason || "").trim();
        await saveNote(`讨论议程已锁定${reason ? `：${reason}` : "。"}`, "decision", "Agenda");
        output = { ok: true, locked: true, agenda: discussionAgenda };
      }
      if (message.name === "request_agenda_change") {
        const change = String(args.change || "").trim();
        const reason = String(args.reason || "").trim();
        setStatusText(change ? `等待议程变更确认：${change}` : "等待议程变更确认");
        output = { ok: true, needsConfirmation: true, change, reason, locked: agendaLocked };
      }
      if (message.name === "score_discussion_progress") {
        const score = Math.max(0, Math.min(100, Number(args.score || 0)));
        const completed = normalizeLines(args.completed).slice(0, 8);
        const blocked = normalizeLines(args.blocked).slice(0, 8);
        const next = normalizeLines(args.next).slice(0, 8);
        output = { ok: true, score, completed, blocked, next };
      }
      if (message.name === "summarize_current_step") {
        const summary = String(args.summary || "").trim();
        const next = String(args.next || "").trim();
        if (!summary) output = { ok: false, error: "Missing step summary." };
        else {
          await saveNote(`${summary}${next ? ` 下一步：${next}` : ""}`, "point", "Step summary");
          output = { ok: true, summary, next };
        }
      }
      if (message.name === "detect_overlong_answer") {
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
      if (message.name === "set_user_cognitive_load") {
        const level = ["simple", "normal", "detailed", "step_by_step"].includes(args.level) ? args.level as CognitiveLoad : "step_by_step";
        setUserCognitiveLoad(level);
        if (level === "simple" || level === "step_by_step") setResponseScope((scope) => ({ ...scope, maxSentences: 2, onePointOnly: true }));
        output = { ok: true, level };
      }
      if (message.name === "pause_and_wait") {
        const reason = String(args.reason || "等待用户继续").trim();
        setStatusText(reason);
        output = { ok: true, paused: true, reason };
      }
      if (message.name === "define_output_rubric") {
        const criteria = normalizeLines(args.criteria).slice(0, 10);
        if (!criteria.length) output = { ok: false, error: "Missing rubric criteria." };
        else {
          setOutputRubric(criteria);
          const file = await createGeneratedFile("产出评价标准.md", `# 产出评价标准\n\n${criteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}`);
          output = { ok: true, criteria, generated: file.originalName };
        }
      }
      if (message.name === "save_discussion_note") {
        const kind = ["point", "decision", "question", "action"].includes(args.kind) ? args.kind as Note["kind"] : "point";
        const text = String(args.text || "").trim();
        if (text) {
          await saveNote(text, kind, "AI summary");
          output = { ok: true, saved: text };
        } else {
          output = { ok: false, error: "Missing note text." };
        }
      }
      if (message.name === "create_generated_file") {
        const title = String(args.title || "AI临时文案.md").trim();
        const text = String(args.text || "").trim();
        if (text) {
          const file = await createGeneratedFile(title, text);
          output = { ok: true, generated: file.originalName };
        } else {
          output = { ok: false, error: "Missing generated file text." };
        }
      }
      if (message.name === "generate_image") {
        const title = String(args.title || "AI生成图片.png").trim();
        const prompt = String(args.prompt || "").trim();
        const size = ["1024x1024", "1024x1536", "1536x1024"].includes(args.size) ? args.size : "1024x1024";
        const quality = ["low", "medium", "high", "auto"].includes(args.quality) ? args.quality : "high";
        if (prompt) {
          const file = await generateImageFile(title, prompt, size, quality);
          output = { ok: true, generated: file.originalName, opened: file.originalName };
        } else {
          output = { ok: false, error: "Missing image prompt." };
        }
      }
      if (message.name === "copy_file_to_generated") {
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
      if (message.name === "add_file_to_topic") {
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
      if (message.name === "move_file_to_area") {
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
      if (message.name === "update_generated_file") {
        const queryText = String(args.query || "").trim().toLowerCase();
        const text = String(args.text || "").trim();
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
      if (message.name === "propose_discussion_directions") {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .map((item: unknown) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 5);
        if (directions.length) {
          setDirectionProposal({ directions, reason: String(args.reason || "").trim() });
          output = { ok: true, proposed: directions };
        } else {
          output = { ok: false, error: "Missing discussion directions." };
        }
      }
      if (message.name === "update_discussion_directions") {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .map((item: unknown) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 8);
        if (directions.length) {
          await confirmDirectionProposal(directions);
          output = { ok: true, directions };
        } else {
          output = { ok: false, error: "Missing discussion directions." };
        }
      }
      if (message.name === "complete_discussion_direction") {
        const queryText = String(args.query || "").trim().toLowerCase();
        const candidate = state.directions.find((direction, index) => {
          return direction.id === queryText || String(index + 1) === queryText || direction.text.toLowerCase().includes(queryText);
        });
        if (candidate) {
          await completeDirection(candidate, String(args.note || "").trim());
          output = { ok: true, completed: candidate.text };
        } else {
          output = { ok: false, error: "No matching discussion direction found." };
        }
      }
      if (message.name === "propose_discussion_topic") {
        const title = String(args.title || "").trim();
        const reason = String(args.reason || "").trim();
        const intent = args.intent === "drift" ? "drift" : "confirm";
        if (topicFileChangeBlocksTopicProposalRef.current) {
          setStatusText("已阻止自动修改主题");
          output = {
            ok: false,
            error: "刚刚发生主题区文件增删。此时只能询问用户下一步，不允许拟确认或修改讨论主题，除非用户明确要求。"
          };
        } else if (title) {
          setTopicProposal({ title, reason, intent });
          output = { ok: true, proposed: title };
        } else {
          output = { ok: false, error: "Missing topic title." };
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
      finishTask();
    }
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: message.call_id,
        output: JSON.stringify(output)
      }
    }));
    requestRealtimeResponse();
  };

  useEffect(() => {
    handleToolCallRef.current = handleToolCall;
  });

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
    setVoiceLevel(0);
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
      const level = readAnalyserLevel(current.inputAnalyser, current.inputData);
      setVoiceLevel((previous) => previous * 0.82 + level * 0.18);
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
    responseActiveRef.current = false;
    responsePendingRef.current = false;
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopVoiceMeter();
    setVoiceState("idle");
    setStatusText("Ready");
  }, [stopVoiceMeter]);

  const stopVoice = useCallback(() => {
    disconnectVoice();
    finalizeDiscussionRecord().catch((err) => setError(err instanceof Error ? err.message : "Unable to archive discussion record"));
  }, [disconnectVoice, finalizeDiscussionRecord]);

  useEffect(() => {
    const saveAndDisconnect = () => {
      voiceSessionRef.current += 1;
      responseActiveRef.current = false;
      responsePendingRef.current = false;
      dataChannelRef.current = null;
      peerRef.current?.close();
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
    assistantTranscriptRef.current = "";
    userTranscriptRef.current = "";
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
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          audioRef.current.play().catch(() => undefined);
        }
        addVoiceOutputMeter(event.streams[0]);
      };
      peer.onconnectionstatechange = () => {
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
      };

      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.onmessage = (event) => {
        if (sessionId !== voiceSessionRef.current) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "response.created") {
            responseActiveRef.current = true;
            setVoiceState("thinking");
          }
          if (message.type === "response.done") {
            responseActiveRef.current = false;
            setVoiceState("live");
            if (pendingTaskCountRef.current === 0 && !backgroundParsingActiveRef.current) setStatusText("Live");
            window.setTimeout(() => flushRealtimeResponse(), 0);
          }
          if (message.type === "response.output_audio_transcript.delta") {
            assistantRespondedSinceUserRef.current = true;
            assistantTranscriptRef.current += message.delta;
            setTranscript(assistantTranscriptRef.current.slice(-220));
          }
          if (message.type === "response.output_audio_transcript.done") {
            const text = String(message.transcript || assistantTranscriptRef.current || "").trim();
            if (text) assistantRespondedSinceUserRef.current = true;
            if (text) saveMeetingMessage(text, "assistant").catch((err) => setError(err instanceof Error ? err.message : "Unable to save meeting record"));
            assistantTranscriptRef.current = "";
          }
          if (message.type === "conversation.item.input_audio_transcription.delta") {
            userTranscriptRef.current += message.delta;
            setTranscript(userTranscriptRef.current.slice(-220));
          }
          if (message.type === "conversation.item.input_audio_transcription.completed") {
            const text = String(message.transcript || userTranscriptRef.current || "").trim();
            if (text) {
              assistantRespondedSinceUserRef.current = false;
              acknowledgeImmediately("收到，我在处理。", true);
              saveMeetingMessage(text, "user").catch((err) => setError(err instanceof Error ? err.message : "Unable to save meeting record"));
            }
            userTranscriptRef.current = "";
          }
          if (message.type === "response.function_call_arguments.done") {
            handleToolCallRef.current?.(message).catch((err) => setError(err.message));
          }
          if (message.type === "error") {
            responseActiveRef.current = false;
            if (/active response in progress/i.test(message.error?.message || "")) responsePendingRef.current = true;
            setError(message.error?.message || "Realtime error");
            setVoiceState("error");
          }
        } catch {
          setTranscript(String(event.data).slice(-220));
        }
      };

      const offer = await peer.createOffer();
      if (sessionId !== voiceSessionRef.current) return;
      await peer.setLocalDescription(offer);
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp
      });
      if (sessionId !== voiceSessionRef.current) return;
      if (!response.ok) throw new Error(await response.text());
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
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
    if (!window.confirm("清空当前讨论？主题文件、资源库、当前生成记录和文字输入都会清空，历史记录卡片会保留。")) return;
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
    setDirectionProposal(null);
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

  const hasTopicCards = primaryFiles.length > 0 || state.directions.length > 0 || Boolean(directionProposal);

  return (
    <main
      className="app-shell"
      style={{
        gridTemplateColumns: `${leftWidth}% 10px minmax(280px, 1fr)`,
        width: `${100 / layoutScale}vw`,
        height: `${100 / layoutScale}vh`,
        minHeight: `${100 / layoutScale}vh`,
        transform: `scale(${layoutScale})`,
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
        {visibleTasks.length ? (
          <TaskIndicator tasks={visibleTasks} />
        ) : (
          <VoiceStatusBubble state={voiceState} statusText={statusText} ambientMode={ambientMode} />
        )}
        <ToolActivityPanel activities={toolActivities} onCancel={cancelCurrentTask} />
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
        <VoiceLevelBars state={voiceState} level={voiceLevel} />
      </div>

      <section
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
          center={
            <TopicConfirmation
              currentTopic={state.discussionTopic}
              proposal={topicProposal}
              onConfirm={(title) => confirmDiscussionTopic(title).catch((err) => setError(err.message))}
              onDismiss={() => setTopicProposal(null)}
            />
          }
          action={
            <div className="header-actions">
              <button className="icon-button" title={fullscreenPanel === "topic" ? "Exit fullscreen topic" : "Fullscreen topic"} onClick={() => setFullscreenPanel(fullscreenPanel === "topic" ? null : "topic")}>
                {fullscreenPanel === "topic" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
              <button className="icon-button" title="新建主题" onClick={() => createNewTopic().catch((err) => setError(err.message))}><Plus size={17} /></button>
              <button className="icon-button danger" title="Clear discussion" onClick={() => clearDiscussion().catch((err) => setError(err.message))}><Trash2 size={17} /></button>
              <button className="icon-button" title="Choose file" onClick={() => primaryInputRef.current?.click()}><FilePlus2 size={18} /></button>
              <button ref={settingsButtonRef} className="icon-button" title="Settings" onClick={toggleSettingsPopover}><Settings2 size={18} /></button>
            </div>
          }
        />
        <div className="topic-preview">
          {hasTopicCards ? (
            <div className="topic-file-list">
              {(state.directions.length > 0 || directionProposal) && (
                <DiscussionDirectionsCard
                  directions={state.directions}
                  proposal={directionProposal}
                  onConfirmProposal={() => directionProposal && confirmDirectionProposal(directionProposal.directions).catch((err) => setError(err.message))}
                  onDismissProposal={() => setDirectionProposal(null)}
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
                    <FilePreview file={file} />
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
      {previewFile && <FilePreviewWindow file={previewFile} onClose={() => setPreviewFileId(null)} />}
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

function TopicConfirmation({
  currentTopic,
  proposal,
  onConfirm,
  onDismiss
}: {
  currentTopic: string;
  proposal: TopicProposal | null;
  onConfirm: (_title: string) => void;
  onDismiss: () => void;
}) {
  if (!proposal && !currentTopic) return null;
  return (
    <aside className={`topic-confirmation ${proposal?.intent === "drift" ? "drift" : ""}`}>
      <div>
        <span>{proposal ? proposal.intent === "drift" ? "主题偏离提醒" : "AI 建议讨论主题" : "当前讨论主题"}</span>
        <strong>{proposal?.title ?? currentTopic}</strong>
        {proposal?.reason && <p>{proposal.reason}</p>}
      </div>
      {proposal && (
        <div className="topic-confirmation-actions">
          <button title="Confirm topic" onClick={() => onConfirm(proposal.title)}><Check size={16} /></button>
          <button title="Dismiss" onClick={onDismiss}><X size={16} /></button>
        </div>
      )}
    </aside>
  );
}

function DiscussionDirectionsCard({
  directions,
  proposal,
  onConfirmProposal,
  onDismissProposal,
  onComplete,
  onDelete
}: {
  directions: DiscussionDirection[];
  proposal: DirectionProposal | null;
  onConfirmProposal: () => void;
  onDismissProposal: () => void;
  onComplete: (_direction: DiscussionDirection) => void;
  onDelete: (_direction: DiscussionDirection) => void;
}) {
  const proposalItems = proposal?.directions ?? [];
  return (
    <article className="topic-file-card directions-card">
      <div className="directions-card-head">
        <span>{proposal ? "待确认方向" : "讨论方向"}</span>
        {proposal && (
          <div className="directions-card-actions">
            <button title="确认方向" onClick={onConfirmProposal}><Check size={14} /></button>
            <button title="关闭" onClick={onDismissProposal}><X size={14} /></button>
          </div>
        )}
      </div>
      {proposal?.reason && <p className="directions-reason">{proposal.reason}</p>}
      <ul className="directions-list">
        {(proposal ? proposalItems : directions).map((item, index) => {
          const text = typeof item === "string" ? item : item.text;
          const completed = typeof item === "string" ? false : item.completed;
          return (
            <li key={typeof item === "string" ? `${text}-${index}` : item.id} className={completed ? "completed" : ""}>
              <button
                className="direction-dot"
                title={completed ? "已完成" : "标记完成"}
                disabled={Boolean(proposal) || completed}
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
  );
});

function TaskIndicator({ tasks }: { tasks: TaskItem[] }) {
  if (!tasks.length) return null;
  const active = tasks[tasks.length - 1];
  return (
    <div className="task-indicator" title={tasks.map((task) => task.label).join(" / ")}>
      <Sparkles size={14} />
      <span>{tasks.length > 1 ? `AI正在执行 ${tasks.length} 个任务` : `AI正在执行：${active.label}`}</span>
    </div>
  );
}

function VoiceStatusBubble({ state, statusText, ambientMode }: { state: VoiceState; statusText: string; ambientMode: boolean }) {
  const text = (() => {
    const status = statusText.trim();
    if (status && !["Ready", "Live", "Connecting", "Error"].includes(status)) return status;
    if (ambientMode) return "氛围模式";
    if (state === "connecting") return "连接中";
    if (state === "thinking") return "思考中";
    if (state === "live") return "听取中";
    if (state === "error") return "连接错误";
    return "待机";
  })();
  if (text === "待机") return null;
  return (
    <div className={`voice-status-bubble ${state}`}>
      <span />
      {text}
    </div>
  );
}

function ToolActivityPanel({ activities, onCancel }: { activities: ToolActivity[]; onCancel: () => void }) {
  const visible = activities.slice(0, 4);
  if (!visible.length) return null;
  return (
    <div className="tool-activity-panel" aria-label="AI工具活动">
      {visible.map((activity) => (
        <details key={activity.id} className={`tool-activity-card ${activity.status}`} open={activity.status === "running"}>
          <summary>
            <span className="tool-activity-dot" />
            <strong>{activity.label}</strong>
            <em>{activity.status === "running" ? "执行中" : activity.status === "done" ? "完成" : activity.status === "failed" ? "失败" : "已取消"}</em>
            {activity.status === "running" && (
              <button type="button" title="取消当前任务" onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }}>
                <X size={12} />
              </button>
            )}
          </summary>
          <p>{activity.result || activity.detail || "等待结果..."}</p>
        </details>
      ))}
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
  if ((file.kind === "doc" || file.kind === "docx") && file.renderedHtml) {
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
  if ((file.kind === "doc" || file.kind === "docx") && file.renderedHtml) {
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

function FilePreviewWindow({ file, onClose }: { file: DiscuzFile; onClose: () => void }) {
  return (
    <aside className="file-preview-window">
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
        <iframe title={page.title || page.url} src={page.url} />
        <p>如果网页没有显示，说明该网站禁止嵌入，可点右上角打开。</p>
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

function VoiceLevelBars({ state, level }: { state: VoiceState; level: number }) {
  const live = state === "live" || state === "thinking";
  const connecting = state === "connecting";
  const multipliers = [0.32, 0.52, 0.82, 0.58, 1, 0.72, 0.44, 0.88, 0.64, 0.38, 0.76, 0.48];
  return (
    <div className={`voice-level-bars ${connecting ? "connecting" : ""} ${live ? "live" : ""}`} aria-hidden="true">
      {multipliers.map((multiplier, index) => {
        const activeLevel = live ? level : 0;
        const shape = 0.42 + multiplier * 0.72;
        const height = 4 + Math.min(1, activeLevel * shape) * 30;
        return <span key={index} style={{ height: `${height}px`, opacity: live ? 0.46 + Math.min(1, activeLevel + 0.15) * 0.54 : 0.3 }} />;
      })}
    </div>
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

  const saveAiSettings = async () => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aiDraft)
      });
      if (!response.ok) throw new Error(await response.text());
      const nextSettings = await response.json();
      onSettingsSaved(nextSettings);
      setMessage("AI 设定已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 设定保存失败");
    } finally {
      setSaving(false);
    }
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
        <span className={settings.openaiApiKeyConfigured ? "status-pill ready" : "status-pill"}>
          {settings.openaiApiKeyConfigured ? `Key: ${settings.openaiApiKeySource}` : "未配置 Key"}
        </span>
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
            <select
              value={aiDraft.realtimeVoice}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, realtimeVoice: event.target.value }))}
            >
              {["shimmer", "alloy", "ash", "ballad", "coral", "echo", "sage", "verse"].map((voice) => (
                <option key={voice} value={voice}>{voice}</option>
              ))}
            </select>
          </label>
          <label>
            语音模型
            <select
              value={aiDraft.realtimeModel}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, realtimeModel: event.target.value }))}
            >
              <option value="gpt-realtime-2">gpt-realtime-2</option>
              <option value="gpt-realtime">gpt-realtime</option>
            </select>
          </label>
          <label>
            转写模型
            <select
              value={aiDraft.transcriptionModel}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, transcriptionModel: event.target.value }))}
            >
              <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
              <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
            </select>
          </label>
          <label>
            图片模型
            <select
              value={aiDraft.imageModel}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, imageModel: event.target.value }))}
            >
              <option value="gpt-image-1.5">gpt-image-1.5</option>
              <option value="gpt-image-1">gpt-image-1</option>
            </select>
          </label>
          <label>
            图片质量
            <select
              value={aiDraft.imageQuality}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, imageQuality: event.target.value as AiSettings["imageQuality"] }))}
            >
              <option value="high">high</option>
              <option value="auto">auto</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </label>
          <label>
            回答长度
            <select
              value={aiDraft.responseLength}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, responseLength: event.target.value as AiSettings["responseLength"] }))}
            >
              <option value="short">短</option>
              <option value="medium">中</option>
              <option value="long">长</option>
            </select>
          </label>
          <label className="wide">
            语气风格
            <input
              value={aiDraft.responseTone}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, responseTone: event.target.value }))}
            />
          </label>
          <label className="wide">
            图片风格
            <input
              value={aiDraft.visualStyle}
              onChange={(event) => setAiDraft((draft) => ({ ...draft, visualStyle: event.target.value }))}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button disabled={saving} onClick={saveAiSettings}>保存 AI 设定</button>
        </div>
      </section>

      <section className="settings-section">
        <label htmlFor="audio-input-device">输入设备</label>
        <div className="device-row">
          <select
            id="audio-input-device"
            value={selectedAudioInputId}
            onChange={(event) => setSelectedAudioInputId(event.target.value)}
          >
            <option value="">系统默认麦克风</option>
            {audioInputDevices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `麦克风 ${index + 1}`}
              </option>
            ))}
          </select>
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

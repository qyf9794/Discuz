import {
  Check,
  CheckCircle2,
  Copy,
  FileText,
  FilePlus2,
  Globe2,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Mic,
  Minus,
  Music,
  PenLine,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from "react";
import type { AppState, DiscussionDirection, DiscussionRecord, DiscussionTopic, DiscuzFile, Note } from "./types";

const emptyState: AppState = {
  files: [],
  notes: [],
  records: [],
  discussionInputs: [],
  directions: [],
  discussionTopic: "",
  activeTopicId: "",
  topics: [],
  activities: [],
  settings: { openaiApiKeyConfigured: false, openaiApiKeySource: "none", wallpaperUrl: "" }
};
type TopicProposal = { title: string; reason: string; intent: "confirm" | "drift" };
type DirectionProposal = { directions: string[]; reason: string };
type SettingsState = NonNullable<AppState["settings"]>;
type VoiceState = "idle" | "connecting" | "live" | "thinking" | "error";
type SearchResult = { title: string; url: string; snippet: string; source: string };
type PanelId = "topic" | "resources" | "record";
type ToolId = "whiteboard" | "draft" | "image" | "video" | "audio";
type StatusLogEntry = { id: string; kind: "status" | "error"; text: string; createdAt: string };
type TaskItem = { id: string; label: string; startedAt: string };
type RealtimeToolCall = { name?: string; arguments?: string; call_id?: string };
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
  return Math.min(1, Math.sqrt(sum / data.length) * 4.8);
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
    propose_discussion_directions: "建议讨论方向",
    update_discussion_directions: "更新讨论方向",
    complete_discussion_direction: "完成讨论方向",
    propose_discussion_topic: "确认讨论主题"
  } as Record<string, string>)[name] || name;
}

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DiscuzFile["role"] | null>(null);
  const [draggingFile, setDraggingFile] = useState<{ id: string; role: DiscuzFile["role"] } | null>(null);
  const [query, setQuery] = useState("");
  const [contextHits, setContextHits] = useState<Array<{ file: DiscuzFile; snippet: string }>>([]);
  const [webHits, setWebHits] = useState<SearchResult[]>([]);
  const [webEnabled, setWebEnabled] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [directionProposal, setDirectionProposal] = useState<DirectionProposal | null>(null);
  const [settingsPopoverStyle, setSettingsPopoverStyle] = useState<CSSProperties>({});
  const [micPermissionOpen, setMicPermissionOpen] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState(() => localStorage.getItem("discuz-audio-input-id") || "");
  const [leftWidth, setLeftWidth] = useState(63);
  const [topHeight, setTopHeight] = useState(75);
  const [layoutScale, setLayoutScale] = useState(1);
  const [fullscreenPanel, setFullscreenPanel] = useState<PanelId | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [previewRecordId, setPreviewRecordId] = useState<string | null>(null);
  const [generatedEditorId, setGeneratedEditorId] = useState<string | null>(null);
  const [discussionText, setDiscussionText] = useState("");
  const [topicProposal, setTopicProposal] = useState<TopicProposal | null>(null);
  const [draftText, setDraftText] = useState(() => localStorage.getItem("discuz-draft") || "");
  const [boardItems, setBoardItems] = useState<Array<{ id: string; kind: "text" | "image"; value: string; x: number; y: number }>>(
    () => loadStoredJson("discuz-board-items", [])
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
  const voiceSessionRef = useRef(0);
  const voiceSessionStartedAtRef = useRef<string | null>(null);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const voiceMeterRef = useRef<VoiceMeter | null>(null);
  const lastStatusLogRef = useRef("Ready");
  const lastErrorLogRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const boardRef = useRef<HTMLDivElement | null>(null);
  const recordStreamRef = useRef<HTMLDivElement | null>(null);

  const primaryFiles = useMemo(() => state.files.filter((file) => file.role === "primary"), [state.files]);
  const contextFiles = useMemo(() => state.files.filter((file) => file.role === "context"), [state.files]);
  const generatedFiles = useMemo(() => state.files.filter((file) => file.role === "generated"), [state.files]);
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
  const compactViewport = layoutScale < 0.95;
  const effectiveTopHeight = compactViewport ? Math.min(topHeight, 62) : topHeight;

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
    localStorage.setItem("discuz-board-items", JSON.stringify(boardItems));
  }, [boardItems]);

  useEffect(() => {
    localStorage.setItem("discuz-board-points", JSON.stringify(drawPoints));
  }, [drawPoints]);

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
  }, [state.notes.length]);

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

  const applyLayoutCommand = (target: PanelId | "reset", mode: string) => {
    if (target === "reset" || mode === "reset") {
      setLeftWidth(63);
      setTopHeight(75);
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
      }
      if (target === "record") {
        setLeftWidth(50);
        setTopHeight(32);
      }
    }
  };

  const beginTask = useCallback((label: string) => {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    setPendingTasks((current) => [...current, { id, label, startedAt }].slice(-6));
    setStatusText(`${label}中`);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      setPendingTasks((current) => current.filter((task) => task.id !== id));
      setStatusText(`${label}完成`);
    };
  }, []);

  const setPrimary = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const finishTask = beginTask("上传主题文件");
    try {
      const payload = await uploadFiles("/api/files/primary", "files", list);
      setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
      setSelectedId(payload.uploaded?.[0]?.id ?? payload.file?.id ?? selectedId);
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
      setGeneratedEditorId(payload.uploaded?.[0]?.id ?? payload.file?.id ?? null);
      setSelectedId(payload.uploaded?.[0]?.id ?? payload.file?.id ?? selectedId);
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
    channel.send(JSON.stringify({ type: "response.create" }));
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

  const openFileDiscussionWindow = (file: DiscuzFile) => {
    setSelectedId(file.id);
    setActiveTool(null);
    setPreviewRecordId(null);
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
    setActiveTool(tool);
    if (tool === "draft") notifyForegroundDiscussion("临时文档", draftText || "当前临时文档为空。");
    if (tool === "whiteboard") notifyForegroundDiscussion("无限白板", boardToMarkdown());
  };

  const openRecordWindow = (recordId: string) => {
    setActiveTool(null);
    setPreviewFileId(null);
    setGeneratedEditorId(null);
    setPreviewRecordId(recordId);
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
    return [
      "# 白板临时记录",
      textItems ? `## 文本\n${textItems}` : "",
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
      setDrawPoints([]);
      setStatusText("白板已保存，已新建空白页");
    }
  };

  const clearToolContent = (tool: ToolId) => {
    if (tool === "draft") setDraftText("");
    if (tool === "whiteboard") {
      setBoardItems([]);
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
        channel.send(JSON.stringify({ type: "response.create" }));
        setStatusText("Text sent");
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
            text: `系统事件：用户已确认讨论主题《${title}》。请先阅读当前主题文件和用户输入；如果目标还不清楚，先询问用户想重点讨论什么。不要立刻提出讨论方向。经过几轮实质讨论、理解用户关注点后，再调用 propose_discussion_directions 提出 3 到 6 个方向等用户确认。`
          }]
        }
      }));
      channel.send(JSON.stringify({ type: "response.create" }));
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

  const notifyPrimaryFileDeleted = (file: DiscuzFile) => {
    setTopicProposal({
      title: state.discussionTopic || "主题文件已删除",
      reason: `主题文件“${file.originalName}”已删除。请确认是停止当前主题讨论，还是更换/上传新的讨论主题文件。`,
      intent: "drift"
    });
    const channel = dataChannelRef.current;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `系统事件：用户刚刚删除了当前讨论主题文件《${file.originalName}》。请立即提醒用户不要继续基于已删除文件讨论，并询问用户：是停止此主题的讨论，还是更换新的讨论主题/上传新的主题文件？`
          }]
        }
      }));
      channel.send(JSON.stringify({ type: "response.create" }));
    }
  };

  const searchAll = async (value = query) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setContextHits([]);
      setWebHits([]);
      return;
    }
    const [contextResponse, webResponse] = await Promise.all([
      fetch(`/api/context/search?q=${encodeURIComponent(trimmed)}`),
      webEnabled ? fetch(`/api/web/search?q=${encodeURIComponent(trimmed)}`) : Promise.resolve(null)
    ]);
    const contextPayload = await contextResponse.json();
    setContextHits(contextPayload.results);
    if (webResponse) {
      const webPayload = await webResponse.json();
      setWebHits(webPayload.results);
    }
  };

  const handleToolCall = async (message: RealtimeToolCall) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open" || !message.call_id || !message.name) return;
    const args = JSON.parse(message.arguments || "{}");
    const finishTask = beginTask(toolCallLabel(message.name));
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
          output = { ok: true, updated: candidate.originalName };
        } else {
          output = { ok: false, error: "No editable generated text file or replacement text found." };
        }
      }
      if (message.name === "propose_discussion_directions") {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .map((item: unknown) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 6);
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
        if (title) {
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
    channel.send(JSON.stringify({ type: "response.create" }));
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
    inputAnalyser.fftSize = 256;
    inputAnalyser.smoothingTimeConstant = 0.72;
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
      const level = Math.max(
        readAnalyserLevel(current.inputAnalyser, current.inputData),
        readAnalyserLevel(current.outputAnalyser, current.outputData)
      );
      setVoiceLevel((previous) => previous * 0.68 + level * 0.32);
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
          if (message.type === "response.created") setVoiceState("thinking");
          if (message.type === "response.done") {
            setVoiceState("live");
            setStatusText("Live");
          }
          if (message.type === "response.output_audio_transcript.delta") {
            assistantTranscriptRef.current += message.delta;
            setTranscript(assistantTranscriptRef.current.slice(-220));
          }
          if (message.type === "response.output_audio_transcript.done") {
            assistantTranscriptRef.current = "";
          }
          if (message.type === "response.function_call_arguments.done") {
            handleToolCallRef.current?.(message).catch((err) => setError(err.message));
          }
          if (message.type === "error") {
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
    const payload = await response.json();
    setState((current) => ({ ...current, ...payload }));
    setSelectedId(null);
    setPreviewFileId(null);
    setPreviewRecordId(null);
    setGeneratedEditorId(null);
    setTopicProposal(null);
    setDirectionProposal(null);
    setDiscussionText("");
    setContextHits([]);
    setWebHits([]);
    setError("");
  };

  const resetLocalDiscussionView = (payload: Partial<AppState>) => {
    setState((current) => ({ ...current, ...payload }));
    const nextFiles = payload.files ?? [];
    setSelectedId(nextFiles.find((file) => file.role === "primary")?.id ?? nextFiles[0]?.id ?? null);
    setPreviewFileId(null);
    setPreviewRecordId(null);
    setGeneratedEditorId(null);
    setActiveTool(null);
    setTopicProposal(null);
    setDirectionProposal(null);
    setDiscussionText("");
    setContextHits([]);
    setWebHits([]);
    setError("");
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
        <TaskIndicator tasks={pendingTasks} />
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

      <section className="right-stack" style={{ gridTemplateRows: `${effectiveTopHeight}% 10px minmax(220px, 1fr)` }}>
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
                <button className="icon-button" title="Whiteboard" onClick={() => openToolDiscussionWindow("whiteboard")}><PenLine size={17} /></button>
                <button className="icon-button" title="Temporary draft" onClick={() => openToolDiscussionWindow("draft")}><FileText size={17} /></button>
                <button className="icon-button" title={fullscreenPanel === "resources" ? "Exit fullscreen resources" : "Fullscreen resources"} onClick={() => setFullscreenPanel(fullscreenPanel === "resources" ? null : "resources")}>
                  {fullscreenPanel === "resources" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
                <button className="icon-button" title="Add resources" onClick={() => contextInputRef.current?.click()}><Upload size={18} /></button>
              </div>
            }
          />
          <button className="resource-drop" onClick={() => contextInputRef.current?.click()}>
            <Upload size={18} />
            <span>拖入资源</span>
          </button>
          <div className="resource-split">
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
              </div>
            </section>
            <section
              className={`resource-zone generated-zone ${dragTarget === "generated" ? "zone-dragging" : ""}`}
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
                {generatedFiles.length ? (
                  generatedFiles.map((file) => (
                    <FileThumb
                      key={file.id}
                      file={file}
                      selected={selectedFile?.id === file.id}
                      onSelect={() => setSelectedId(file.id)}
                      onOpen={() => openFileDiscussionWindow(file)}
                      onDelete={() => deleteFile(file).catch((err) => setError(err.message))}
                      onDragStart={(event) => {
                        setDraggingFile({ id: file.id, role: file.role });
                        event.dataTransfer.setData(fileDragType, file.id);
                        event.dataTransfer.effectAllowed = "move";
                        setCardDragImage(event);
                      }}
                      onDragEnd={() => setDraggingFile(null)}
                      dragMark={draggingFile?.id === file.id ? "add" : null}
                    />
                  ))
                ) : (
                  <button className="thumb empty-generated" onClick={() => generatedInputRef.current?.click()}>
                    <FileText size={22} />
                    <span>添加临时文件</span>
                  </button>
                )}
              </div>
            </section>
          </div>
          <div className="search-card">
            <div className="search-line">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && searchAll()}
                placeholder="Search"
              />
              <button title="Web search" className={webEnabled ? "web-on" : ""} onClick={() => setWebEnabled((value) => !value)}>
                <Globe2 size={15} />
              </button>
            </div>
            <div className="hit-list">
              {contextHits.map((hit) => (
                <button key={hit.file.id} onClick={() => setSelectedId(hit.file.id)}>
                  <span>{hit.file.originalName}</span>
                  <p>{hit.snippet}</p>
                </button>
              ))}
              {webHits.map((hit) => (
                <a key={hit.url} href={hit.url} target="_blank" rel="noreferrer">
                  <span>{hit.title}</span>
                  <p>{hit.snippet}</p>
                </a>
              ))}
            </div>
          </div>
        </section>

        <div className="row-resizer" onPointerDown={startRowResize} />

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
                <strong>生成记录</strong>
                <span>{currentNotes.length} 段</span>
              </header>
              <div className="record-stream" ref={recordStreamRef}>
                {currentNotes.length ? (
                  currentNotes.map((note) => (
                    <article key={note.id} className="note-line">
                      <span>{noteLabel(note.kind)} · {shortTime(note.createdAt)}</span>
                      <p>{note.text}</p>
                    </article>
                  ))
                ) : (
                  <div className="empty-record">
                    <CheckCircle2 size={22} />
                    <span>讨论要点会按段落生成</span>
                  </div>
                )}
              </div>
            </section>
            <section className="record-history">
              <header>
                <strong>历史记录</strong>
                <span>{state.records.length} 张</span>
              </header>
              <div className="history-card-list">
                {state.records.length ? (
                  state.records.map((record) => (
                    <button key={record.id} className="history-card" onDoubleClick={() => openRecordWindow(record.id)}>
                      <span>{record.noteCount} 段 · {shortTime(record.createdAt)}</span>
                      <strong>{record.title}</strong>
                      <p>{record.content}</p>
                    </button>
                  ))
                ) : (
                  <div className="empty-record">
                    <FileText size={22} />
                    <span>关闭麦克风后生成记录卡片</span>
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
      <span>{tasks.length > 1 ? `${tasks.length} 个任务` : active.label}</span>
    </div>
  );
}

function EmptyTopic({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="empty-topic">
      <Sparkles size={26} />
      <button onClick={onChoose}>Open file</button>
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
  boardItems: Array<{ id: string; kind: "text" | "image"; value: string; x: number; y: number }>;
  setBoardItems: Dispatch<SetStateAction<Array<{ id: string; kind: "text" | "image"; value: string; x: number; y: number }>>>;
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
            {drawPoints.map((point) => <i key={point.id} className="draw-point" style={{ left: point.x, top: point.y }} />)}
            {boardItems.map((item) => (
              <div key={item.id} className={`board-item ${item.kind}`} style={{ left: item.x, top: item.y }}>
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
        const activeLevel = live || connecting ? level : 0;
        const height = 5 + Math.min(1, activeLevel * (0.5 + multiplier)) * 33;
        return <span key={index} style={{ height: `${height}px` }} />;
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
  const wallpaperInputRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

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

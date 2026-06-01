import {
  Check,
  CheckCircle2,
  FileText,
  FilePlus2,
  Globe2,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Mic,
  Music,
  PenLine,
  Search,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from "react";
import type { AppState, DiscussionRecord, DiscuzFile, Note } from "./types";

const emptyState: AppState = {
  files: [],
  notes: [],
  records: [],
  discussionInputs: [],
  discussionTopic: "",
  activities: [],
  settings: { openaiApiKeyConfigured: false, openaiApiKeySource: "none" }
};
type TopicProposal = { title: string; reason: string; intent: "confirm" | "drift" };
type SettingsState = NonNullable<AppState["settings"]>;
type VoiceState = "idle" | "connecting" | "live" | "thinking" | "error";
type SearchResult = { title: string; url: string; snippet: string; source: string };
type PanelId = "topic" | "resources" | "record";
type ToolId = "whiteboard" | "draft" | "image" | "video" | "audio";

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

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<"primary" | "context" | null>(null);
  const [query, setQuery] = useState("");
  const [contextHits, setContextHits] = useState<Array<{ file: DiscuzFile; snippet: string }>>([]);
  const [webHits, setWebHits] = useState<SearchResult[]>([]);
  const [webEnabled, setWebEnabled] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(63);
  const [topHeight, setTopHeight] = useState(75);
  const [fullscreenPanel, setFullscreenPanel] = useState<PanelId | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [previewRecordId, setPreviewRecordId] = useState<string | null>(null);
  const [discussionText, setDiscussionText] = useState("");
  const [topicProposal, setTopicProposal] = useState<TopicProposal | null>(null);
  const [draftText, setDraftText] = useState(() => localStorage.getItem("discuz-draft") || "");
  const [boardItems, setBoardItems] = useState<Array<{ id: string; kind: "text" | "image"; value: string; x: number; y: number }>>([]);
  const [drawPoints, setDrawPoints] = useState<Array<{ id: string; x: number; y: number }>>([]);
  const [drawing, setDrawing] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [statusText, setStatusText] = useState("Ready");
  const [error, setError] = useState("");
  const primaryInputRef = useRef<HTMLInputElement | null>(null);
  const contextInputRef = useRef<HTMLInputElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const voiceSessionRef = useRef(0);
  const voiceSessionStartedAtRef = useRef<string | null>(null);
  const assistantTranscriptRef = useRef("");
  const boardRef = useRef<HTMLDivElement | null>(null);
  const recordStreamRef = useRef<HTMLDivElement | null>(null);

  const primaryFiles = useMemo(() => state.files.filter((file) => file.role === "primary"), [state.files]);
  const contextFiles = useMemo(() => state.files.filter((file) => file.role === "context"), [state.files]);
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
  const currentNotes = useMemo(() => [...state.notes].reverse(), [state.notes]);

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

  useEffect(() => {
    if (recordStreamRef.current) {
      recordStreamRef.current.scrollTop = recordStreamRef.current.scrollHeight;
    }
  }, [state.notes.length]);

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

  const setPrimary = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const payload = await uploadFiles("/api/files/primary", "files", list);
    setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
    setSelectedId(payload.uploaded?.[0]?.id ?? payload.file?.id ?? selectedId);
    setError("");
  };

  const addContext = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const payload = await uploadFiles("/api/files/context", "files", list);
    setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
    setError("");
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

  const sendDiscussionInput = async () => {
    const text = discussionText.trim();
    if (!text) return;
    setDiscussionText("");
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
      activities: payload.activities ?? current.activities
    }));
    setTopicProposal(null);
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

  const handleToolCall = async (message: { name?: string; arguments?: string; call_id?: string }) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open" || !message.call_id || !message.name) return;
    const args = JSON.parse(message.arguments || "{}");
    let output = {};
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
      setActiveTool((args.tool || "whiteboard") as ToolId);
      output = { ok: true, opened: args.tool };
    }
    if (message.name === "open_file_preview") {
      const role = args.role === "primary" || args.role === "context" ? args.role : undefined;
      const queryText = String(args.query || "").trim().toLowerCase();
      const candidate = state.files.find((file) => {
        const roleMatches = !role || file.role === role;
        const nameMatches = !queryText || file.originalName.toLowerCase().includes(queryText);
        return roleMatches && nameMatches;
      }) ?? state.files.find((file) => !role || file.role === role);
      if (candidate) {
        setSelectedId(candidate.id);
        setPreviewFileId(candidate.id);
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

  const stopVoice = useCallback(() => {
    voiceSessionRef.current += 1;
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setVoiceState("idle");
    setStatusText("Ready");
    finalizeDiscussionRecord().catch((err) => setError(err instanceof Error ? err.message : "Unable to archive discussion record"));
  }, [finalizeDiscussionRecord]);

  const startVoice = async () => {
    setError("");
    const sessionId = voiceSessionRef.current + 1;
    voiceSessionRef.current = sessionId;
    voiceSessionStartedAtRef.current = new Date().toISOString();
    setVoiceState("connecting");
    setStatusText("Connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionId !== voiceSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          audioRef.current.play().catch(() => undefined);
        }
      };
      peer.onconnectionstatechange = () => {
        if (sessionId !== voiceSessionRef.current) return;
        if (peer.connectionState === "connected") {
          setVoiceState("live");
          setStatusText("Live");
        }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) stopVoice();
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
            handleToolCall(message).catch((err) => setError(err.message));
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
      setError(err instanceof Error ? err.message : "Unable to start voice session");
    }
  };

  const handleDrop = async (event: DragEvent<HTMLElement>, target: "primary" | "context") => {
    event.preventDefault();
    setDragTarget(null);
    if (target === "primary") await setPrimary(event.dataTransfer.files);
    else await addContext(event.dataTransfer.files);
  };

  const onPrimaryChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await setPrimary(event.target.files || []);
    event.target.value = "";
  };

  const onContextChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await addContext(event.target.files || []);
    event.target.value = "";
  };

  const deleteFile = async (file: DiscuzFile) => {
    if (!window.confirm(`删除“${file.originalName}”？`)) return;
    const wasPrimary = file.role === "primary";
    const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
    if (selectedId === file.id) setSelectedId(payload.files[0]?.id ?? null);
    if (previewFileId === file.id) setPreviewFileId(null);
    if (wasPrimary) notifyPrimaryFileDeleted(file);
    setError("");
  };

  const clearDiscussion = async () => {
    if (!window.confirm("清空当前讨论？主题文件、资源库、当前生成记录和文字输入都会清空，历史记录卡片会保留。")) return;
    voiceSessionRef.current += 1;
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setVoiceState("idle");
    setStatusText("Ready");
    await finalizeDiscussionRecord();
    const response = await fetch("/api/discussion/reset", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setState((current) => ({ ...current, ...payload }));
    setSelectedId(null);
    setPreviewFileId(null);
    setPreviewRecordId(null);
    setTopicProposal(null);
    setDiscussionText("");
    setContextHits([]);
    setWebHits([]);
    setError("");
  };

  return (
    <main
      className="app-shell"
      style={{
        gridTemplateColumns: `${leftWidth}% 10px minmax(280px, 1fr)`
      }}
    >
      <input ref={primaryInputRef} hidden type="file" multiple onChange={onPrimaryChange} />
      <input ref={contextInputRef} hidden type="file" multiple onChange={onContextChange} />
      <audio ref={audioRef} autoPlay />
      <div className="light-wash" />
      <div className="bottom-discussion-bar">
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
          <VoiceButton state={voiceState} onStart={startVoice} onStop={stopVoice} />
        </div>
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
          title="讨论主题"
          meta={primaryFiles.length ? `${primaryFiles.length} 个主题文件` : "拖入主题文件"}
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
              <button className="icon-button danger" title="Clear discussion" onClick={() => clearDiscussion().catch((err) => setError(err.message))}><Trash2 size={17} /></button>
              <button className="icon-button" title="Choose file" onClick={() => primaryInputRef.current?.click()}><FilePlus2 size={18} /></button>
              <button ref={settingsButtonRef} className="icon-button" title="Settings" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={18} /></button>
            </div>
          }
        />
        <div className="topic-preview">
          {primaryFiles.length ? (
            <div className="topic-file-list">
              {primaryFiles.map((file) => (
                <article
                  key={file.id}
                  className={`topic-file-card ${selectedId === file.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(file.id)}
                  onDoubleClick={() => {
                    setSelectedId(file.id);
                    setPreviewFileId(file.id);
                  }}
                >
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

      <section className="right-stack" style={{ gridTemplateRows: `${topHeight}% 10px minmax(220px, 1fr)` }}>
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
            meta={`${contextFiles.length} 项`}
            action={
              <div className="header-actions">
                <button className="icon-button" title="Whiteboard" onClick={() => setActiveTool("whiteboard")}><PenLine size={17} /></button>
                <button className="icon-button" title="Temporary draft" onClick={() => setActiveTool("draft")}><FileText size={17} /></button>
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
          <div className="resource-grid">
            {contextFiles.map((file) => (
              <article
                key={file.id}
                className={`thumb ${selectedFile?.id === file.id ? "selected" : ""}`}
                onClick={() => setSelectedId(file.id)}
                onDoubleClick={() => {
                  setSelectedId(file.id);
                  setPreviewFileId(file.id);
                }}
              >
                <button
                  className="card-delete"
                  title="Delete resource file"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteFile(file).catch((err) => setError(err.message));
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <Trash2 size={13} />
                </button>
                <div className="thumb-preview">
                  <FileMiniPreview file={file} />
                </div>
                <footer>
                  <span>{file.kind}</span>
                  <strong>{file.originalName}</strong>
                </footer>
              </article>
            ))}
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
            meta={transcript || statusText}
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
                    <button key={record.id} className="history-card" onDoubleClick={() => setPreviewRecordId(record.id)}>
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
          onSettingsSaved={(settings) => setState((current) => ({ ...current, settings }))}
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
          onClose={() => setActiveTool(null)}
        />
      )}
      {previewFile && <FilePreviewWindow file={previewFile} onClose={() => setPreviewFileId(null)} />}
      {previewRecord && <RecordPreviewWindow record={previewRecord} onClose={() => setPreviewRecordId(null)} />}
      {error && <div className="toast">{error}</div>}
    </main>
  );
}

function PanelHeader({ title, meta, center, action }: { title: string; meta: string; center?: ReactNode; action: ReactNode }) {
  return (
    <header className="panel-head">
      <div className="panel-title">
        <h2>{title}</h2>
        <p>{meta}</p>
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
  if (file.extractedText) return <pre>{file.extractedText.slice(0, 600)}</pre>;
  return <div className="mini-icon">{file.kind}</div>;
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
  onClose: () => void;
}) {
  const title = {
    whiteboard: "无限白板",
    draft: "临时文档",
    image: "图像查看",
    video: "视频查看",
    audio: "录音播放"
  }[tool];

  const addBoardText = () => {
    setBoardItems((items) => [...items, { id: crypto.randomUUID(), kind: "text", value: "新的观点", x: 80 + items.length * 24, y: 80 + items.length * 18 }]);
  };

  const addBoardImage = () => {
    if (!selectedFile || selectedFile.kind !== "image") return;
    setBoardItems((items) => [...items, { id: crypto.randomUUID(), kind: "image", value: selectedFile.previewUrl, x: 120, y: 120 }]);
  };

  return (
    <aside className={`tool-window ${tool === "whiteboard" ? "whiteboard-window" : ""}`}>
      <header className="tool-head">
        <strong>{title}</strong>
        <div className="header-actions">
          {tool === "whiteboard" && (
            <>
              <button className="icon-button" title="Add text" onClick={addBoardText}><FileText size={16} /></button>
              <button className="icon-button" title="Add image" onClick={addBoardImage}><ImageIcon size={16} /></button>
              <button className={`icon-button ${drawing ? "active" : ""}`} title="Draw" onClick={() => setDrawing((value) => !value)}><PenLine size={16} /></button>
              <button className="icon-button" title="Clear drawing" onClick={() => setDrawPoints([])}><Trash2 size={16} /></button>
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
            const rect = event.currentTarget.getBoundingClientRect();
            setDrawPoints((points) => [...points, {
              id: crypto.randomUUID(),
              x: event.clientX - rect.left + event.currentTarget.scrollLeft,
              y: event.clientY - rect.top + event.currentTarget.scrollTop
            }].slice(-2200));
          }}
          onDoubleClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setBoardItems((items) => [...items, { id: crypto.randomUUID(), kind: "text", value: "双击添加", x: event.clientX - rect.left + event.currentTarget.scrollLeft, y: event.clientY - rect.top + event.currentTarget.scrollTop }]);
          }}
        >
          <div className="board-canvas">
            {drawPoints.map((point) => <i key={point.id} className="draw-point" style={{ left: point.x, top: point.y }} />)}
            {boardItems.map((item) => (
              <div key={item.id} className={`board-item ${item.kind}`} style={{ left: item.x, top: item.y }}>
                {item.kind === "image" ? <img src={item.value} alt="" /> : <textarea defaultValue={item.value} />}
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

const SettingsPopover = forwardRef<HTMLElement, {
  settings: SettingsState;
  webEnabled: boolean;
  setWebEnabled: (_next: boolean) => void;
  onSettingsSaved: (_settings: SettingsState) => void;
}>(function SettingsPopover({
  settings,
  webEnabled,
  setWebEnabled,
  onSettingsSaved
}, ref) {
  const [apiKey, setApiKey] = useState("");
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

  return (
    <aside ref={ref} className="settings-popover">
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

      <section className="settings-section compact">
        <div>
          <strong>Web</strong>
          <button className={webEnabled ? "toggle enabled" : "toggle"} onClick={() => setWebEnabled(!webEnabled)}>
            <span />
          </button>
        </div>
        <p>AI 可按需查阅互联网，但回答必须回到当前主题。</p>
      </section>
    </aside>
  );
});

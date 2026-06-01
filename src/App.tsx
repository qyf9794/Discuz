import {
  CheckCircle2,
  FileText,
  FilePlus2,
  Globe2,
  Image as ImageIcon,
  Maximize2,
  Mic,
  MicOff,
  MoreHorizontal,
  Music,
  PenLine,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Video
} from "lucide-react";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from "react";
import type { Activity, AppState, DiscuzFile, Note } from "./types";

const emptyState: AppState = { files: [], notes: [], activities: [] };
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
  const [topHeight, setTopHeight] = useState(50);
  const [fullscreenPanel, setFullscreenPanel] = useState<PanelId | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const assistantTranscriptRef = useRef("");
  const boardRef = useRef<HTMLDivElement | null>(null);

  const primaryFile = useMemo(() => state.files.find((file) => file.role === "primary") ?? null, [state.files]);
  const contextFiles = useMemo(() => state.files.filter((file) => file.role === "context"), [state.files]);
  const selectedFile = useMemo(
    () => state.files.find((file) => file.id === selectedId) ?? primaryFile,
    [state.files, selectedId, primaryFile]
  );

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
      setTopHeight(Math.min(72, Math.max(30, startHeight + delta)));
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
      setTopHeight(50);
      setFullscreenPanel(null);
      return;
    }
    if (mode === "fullscreen") setFullscreenPanel(target);
    if (mode === "focus") {
      setFullscreenPanel(null);
      if (target === "topic") setLeftWidth(74);
      if (target === "resources") {
        setLeftWidth(50);
        setTopHeight(68);
      }
      if (target === "record") {
        setLeftWidth(50);
        setTopHeight(32);
      }
    }
  };

  const setPrimary = async (files: FileList | File[]) => {
    const file = Array.from(files)[0];
    if (!file) return;
    const payload = await uploadFiles("/api/files/primary", "file", [file]);
    setState((current) => ({ ...current, files: payload.files, activities: payload.activities }));
    setSelectedId(payload.file.id);
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

  const stopVoice = useCallback(() => {
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setVoiceState("idle");
    setStatusText("Ready");
  }, []);

  const startVoice = async () => {
    setError("");
    setVoiceState("connecting");
    setStatusText("Connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        if (peer.connectionState === "connected") {
          setVoiceState("live");
          setStatusText("Live");
        }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) stopVoice();
      };

      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.onmessage = (event) => {
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
            const text = assistantTranscriptRef.current.trim();
            assistantTranscriptRef.current = "";
            if (text.length > 44) saveNote(text.slice(0, 240), "point", "Realtime").catch(() => undefined);
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
      await peer.setLocalDescription(offer);
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp
      });
      if (!response.ok) throw new Error(await response.text());
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    } catch (err) {
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

  return (
    <main
      className="app-shell"
      style={{
        gridTemplateColumns: `${leftWidth}% 10px minmax(280px, 1fr)`
      }}
    >
      <input ref={primaryInputRef} hidden type="file" onChange={onPrimaryChange} />
      <input ref={contextInputRef} hidden type="file" multiple onChange={onContextChange} />
      <audio ref={audioRef} autoPlay />
      <div className="light-wash" />

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
          meta={primaryFile?.originalName || "拖入主文件"}
          action={
            <div className="header-actions">
              <button className="icon-button" title="Fullscreen topic" onClick={() => setFullscreenPanel(fullscreenPanel === "topic" ? null : "topic")}><Maximize2 size={17} /></button>
              <button className="icon-button" title="Choose file" onClick={() => primaryInputRef.current?.click()}><FilePlus2 size={18} /></button>
            </div>
          }
        />
        <div className="topic-preview">
          {selectedFile ? <FilePreview file={selectedFile} /> : <EmptyTopic onChoose={() => primaryInputRef.current?.click()} />}
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
                <button className="icon-button" title="Fullscreen resources" onClick={() => setFullscreenPanel(fullscreenPanel === "resources" ? null : "resources")}><Maximize2 size={17} /></button>
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
              <button
                key={file.id}
                className={`thumb ${selectedFile?.id === file.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedId(file.id);
                  if (["image", "audio", "video"].includes(file.kind)) setActiveTool(file.kind as ToolId);
                }}
              >
                <FileThumb file={file} />
                <span>{file.originalName}</span>
              </button>
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
                <button className="icon-button" title="Whiteboard" onClick={() => setActiveTool("whiteboard")}><PenLine size={17} /></button>
                <button className="icon-button" title="Temporary draft" onClick={() => setActiveTool("draft")}><FileText size={17} /></button>
                <VoiceButton state={voiceState} onStart={startVoice} onStop={stopVoice} />
                <button className="icon-button" title="Fullscreen record" onClick={() => setFullscreenPanel(fullscreenPanel === "record" ? null : "record")}><Maximize2 size={17} /></button>
                <button className="icon-button" title="Settings" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={18} /></button>
              </div>
            }
          />
          <div className="record-list">
            {state.notes.length ? (
              state.notes.map((note) => (
                <article key={note.id} className="note-card">
                  <span>{noteLabel(note.kind)}</span>
                  <p>{note.text}</p>
                  <small>{shortTime(note.createdAt)}</small>
                </article>
              ))
            ) : (
              <div className="empty-record">
                <CheckCircle2 size={22} />
                <span>要点会在这里出现</span>
              </div>
            )}
          </div>
          <ActivityMini activities={state.activities} />
        </section>
      </section>

      {settingsOpen && <SettingsPopover webEnabled={webEnabled} setWebEnabled={setWebEnabled} />}
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
      {error && <div className="toast">{error}</div>}
    </main>
  );
}

function PanelHeader({ title, meta, action }: { title: string; meta: string; action: ReactNode }) {
  return (
    <header className="panel-head">
      <div>
        <h2>{title}</h2>
        <p>{meta}</p>
      </div>
      {action}
    </header>
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

function FileThumb({ file }: { file: DiscuzFile }) {
  if (file.kind === "image") return <img src={file.previewUrl} alt="" />;
  if (file.kind === "audio") return <div><Music size={18} /></div>;
  if (file.kind === "video") return <div><Video size={18} /></div>;
  return <div>{file.kind}</div>;
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
  const live = state === "live" || state === "thinking";
  return (
    <button className={`voice-button ${live ? "live" : ""}`} onClick={live ? onStop : onStart} title={live ? "Stop" : "Start"}>
      {live ? <MicOff size={18} /> : <Mic size={18} />}
    </button>
  );
}

function SettingsPopover({ webEnabled, setWebEnabled }: { webEnabled: boolean; setWebEnabled: (_next: boolean) => void }) {
  return (
    <aside className="settings-popover">
      <div>
        <strong>Web</strong>
        <button className={webEnabled ? "toggle enabled" : "toggle"} onClick={() => setWebEnabled(!webEnabled)}>
          <span />
        </button>
      </div>
      <p>AI 可按需查阅互联网，但回答必须回到当前主题。</p>
    </aside>
  );
}

function ActivityMini({ activities }: { activities: Activity[] }) {
  const labels = Array.from(new Set(activities.map((activity) => activity.label))).slice(0, 3);
  return (
    <div className="activity-mini">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
      {!labels.length && <span>Local</span>}
      <MoreHorizontal size={15} />
    </div>
  );
}

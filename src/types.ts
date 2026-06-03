export type DiscuzFile = {
  id: string;
  topicId?: string;
  role: "primary" | "context" | "generated";
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  kind: "image" | "audio" | "video" | "pdf" | "doc" | "docx" | "ppt" | "pptx" | "spreadsheet" | "markdown" | "text" | "unknown";
  extractedText: string;
  renderedHtml: string;
  summary: string;
  extractionStatus?: "pending" | "processing" | "complete" | "error";
  extractionError?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
};

export type DiscussionTopic = {
  id: string;
  title: string;
  folderName: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  recordCount: number;
  active: boolean;
};

export type Note = {
  id: string;
  kind: "point" | "decision" | "question" | "action";
  text: string;
  source: string;
  createdAt: string;
};

export type Activity = {
  id: string;
  label: string;
  detail: string;
  createdAt: string;
};

export type DiscussionRecord = {
  id: string;
  title: string;
  content: string;
  noteCount: number;
  startedAt: string;
  endedAt: string;
  createdAt: string;
};

export type DiscussionInput = {
  id: string;
  text: string;
  source: "user" | "ai";
  createdAt: string;
};

export type MeetingMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type DiscussionDirection = {
  id: string;
  text: string;
  completed: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type AiSettings = {
  assistantName: string;
  realtimeModel: string;
  realtimeVoice: string;
  transcriptionModel: string;
  imageModel: string;
  imageQuality: "low" | "medium" | "high" | "auto";
  responseLength: "short" | "medium" | "long";
  responseTone: string;
  visualStyle: string;
};

export type AppState = {
  files: DiscuzFile[];
  notes: Note[];
  records: DiscussionRecord[];
  discussionInputs: DiscussionInput[];
  meetingMessages: MeetingMessage[];
  directions: DiscussionDirection[];
  discussionTopic: string;
  activeTopicId: string;
  topics: DiscussionTopic[];
  activities: Activity[];
  settings?: {
    openaiApiKeyConfigured: boolean;
    openaiApiKeySource: "local" | "env" | "none";
    wallpaperUrl: string;
    ai: AiSettings;
  };
};

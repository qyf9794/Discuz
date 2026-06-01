export type DiscuzFile = {
  id: string;
  role: "primary" | "context";
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  kind: "image" | "audio" | "video" | "pdf" | "doc" | "docx" | "pptx" | "markdown" | "text" | "unknown";
  extractedText: string;
  renderedHtml: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
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

export type AppState = {
  files: DiscuzFile[];
  notes: Note[];
  records: DiscussionRecord[];
  discussionInputs: DiscussionInput[];
  discussionTopic: string;
  activities: Activity[];
  settings?: {
    openaiApiKeyConfigured: boolean;
    openaiApiKeySource: "local" | "env" | "none";
  };
};

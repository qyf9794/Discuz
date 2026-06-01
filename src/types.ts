export type DiscuzFile = {
  id: string;
  role: "primary" | "context";
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  kind: "image" | "audio" | "video" | "pdf" | "docx" | "pptx" | "markdown" | "text" | "unknown";
  extractedText: string;
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

export type AppState = {
  files: DiscuzFile[];
  notes: Note[];
  activities: Activity[];
};

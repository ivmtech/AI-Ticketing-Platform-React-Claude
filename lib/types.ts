export type Priority = '高' | '中' | '低';

export interface ScanEntry {
  groupName: string;
  senderName: string;
  senderNumber: string;
  messageContent: string;
  timestamp: Date;
  clientSummary: string;
  reason: string;
  priority: Priority;
  confidence: number;
  needsReview: boolean;
}

export interface SkippedEntry {
  groupName: string;
  reason: string;
}

export interface ScanResult {
  resolved: ScanEntry[];
  unresolved: ScanEntry[];
  skipped: SkippedEntry[];
  scannedGroups: number;
  totalGroups: number;
  truncated?: boolean;
}

export interface ReportPayload {
  html: string;
  text: string;
  todoCount: number;
  total: number;
}

export interface ScanProgress {
  current: number;
  total: number;
}

export interface LastResult {
  resolved: number;
  unresolved: number;
  skipped: number;
}

export interface AppState {
  isRunning: boolean;
  progress: ScanProgress;
  lastResult: LastResult | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastReportHtml: string | null;
  logs: string[];
  reportEmails: string[];
  scanMissedDueToDisconnect: boolean;
}

export interface EnrichedMessage {
  body: string;
  timestamp: number;
  author: string | undefined;
  senderName: string;
  fromMe?: boolean;
}

export interface ClaudeAnalysisResult {
  resolved: boolean;
  clientSummary: string;
  reason: string;
  priority: Priority;
  confidence: number;
  needsReview: boolean;
  lastClientMsg: EnrichedMessage | null;
  lastOverallMsg?: EnrichedMessage | null;
}

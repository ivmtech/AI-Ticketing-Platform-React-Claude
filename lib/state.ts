import type { AppState } from './types';

declare global {
  // eslint-disable-next-line no-var
  var __appState: AppState | undefined;
}

function createInitialState(): AppState {
  return {
    isRunning: false,
    progress: { current: 0, total: 0 },
    lastResult: null,
    lastRunAt: null,
    nextRunAt: null,
    lastReportHtml: null,
    logs: [],
    reportEmails: process.env.REPORT_EMAIL
      ? process.env.REPORT_EMAIL.split(',').map((e) => e.trim()).filter(Boolean)
      : [],
  };
}

if (!globalThis.__appState) {
  globalThis.__appState = createInitialState();
}

const state = globalThis.__appState as AppState;
export default state;

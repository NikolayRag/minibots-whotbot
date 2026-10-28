export type ProcessState = "running" | "paused" | "stopped";

export interface ProcessRecord {
  id: string;
  userId: string;
  title: string;
  description: string;
  metadata: unknown;
  state: ProcessState;
  createdAt: number;
  startedAt: number;
  endedAt: number | null;
  createdSeq: number;
}

export interface IntervalRecord {
  id: string;
  processId: string;
  startedAt: number;
  endedAt: number | null;
}

export interface ProcessSummary extends ProcessRecord {
  activeDurationMs: number;
  elapsedSinceStartMs: number;
  intervals: IntervalRecord[];
}

export interface Report {
  generatedAt: number;
  range: { from: number | null; to: number };
  completed: {
    count: number;
    totalActiveDurationMs: number;
  };
  paused: {
    count: number;
    oldestFirstStartAt: number | null;
    oldestElapsedSinceStartMs: number | null;
    processes: ProcessSummary[];
  };
  latest: ProcessSummary | null;
}

export interface StartInput {
  userId: string;
  title: string;
  description?: string;
  metadata?: unknown;
  at?: number;
}

export interface ProcessLibrary {
  start(input: StartInput): Promise<ProcessRecord>;
  stop(userId: string, at?: number): Promise<ProcessRecord | null>;
  report(userId: string, range?: { from?: number; to?: number }): Promise<Report>;
}

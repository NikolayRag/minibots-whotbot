import type {
  ProcessLibrary, ProcessRecord, ProcessState, Report, StartInput,
  ProcessSummary, IntervalRecord
} from "./types";

export interface StorageAdapter {
  start(input: StartInput): Promise<ProcessRecord>;
  stop(userId: string, at?: number): Promise<ProcessRecord | null>;
  report(userId: string, range?: { from?: number; to?: number }): Promise<Report>;
}

export function createProcessLibrary(storage: StorageAdapter): ProcessLibrary {
  return {
    start: (input) => {
      const title = input.title.trim();
      if (!input.userId.trim()) throw new Error("userId is required");
      if (!title) throw new Error("title is required");
      if (input.metadata !== undefined) JSON.stringify(input.metadata);
      return storage.start({ ...input, title });
    },
    stop: (userId, at) => {
      if (!userId.trim()) throw new Error("userId is required");
      return storage.stop(userId, at);
    },
    report: (userId, range) => {
      if (!userId.trim()) throw new Error("userId is required");
      if (range?.from !== undefined && !Number.isFinite(range.from)) throw new Error("range.from must be a timestamp in milliseconds");
      if (range?.to !== undefined && !Number.isFinite(range.to)) throw new Error("range.to must be a timestamp in milliseconds");
      if (range?.from !== undefined && range?.to !== undefined && range.from > range.to) throw new Error("range.from must not exceed range.to");
      return storage.report(userId, range);
    }
  };
}

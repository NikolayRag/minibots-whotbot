import type { D1Database, D1Result } from "@cloudflare/workers-types";
import type { ProcessRecord, Report, StartInput, ProcessSummary, IntervalRecord, ProcessState } from "./types";
import type { StorageAdapter } from "./library";

type StateRow = { user_id: string; active_process_id: string | null; stack_json: string; next_seq: number; updated_at: number };
type ProcessRow = { id: string; user_id: string; title: string; description: string; metadata_json: string; state: ProcessState; created_at: number; started_at: number; ended_at: number | null; created_seq: number };
type IntervalRow = { id: string; process_id: string; started_at: number; ended_at: number | null };

const uid = () => crypto.randomUUID();
const parseMeta = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return {}; } };

function mapProcess(row: ProcessRow): ProcessRecord {
  return {
    id: row.id, userId: row.user_id, title: row.title, description: row.description,
    metadata: parseMeta(row.metadata_json), state: row.state,
    createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at,
    createdSeq: row.created_seq
  };
}

export class D1ProcessStorage implements StorageAdapter {
  constructor(private readonly db: D1Database) {}

  async start(input: StartInput): Promise<ProcessRecord> {
    const at = input.at ?? Date.now();
    const userId = input.userId;
    const id = uid();
    const intervalId = uid();
    const metadata = JSON.stringify(input.metadata ?? {});
    const title = input.title.trim();
    const description = input.description ?? "";

    // D1 batch is transactional. The user_state row is the per-user serialization point.
    const state = await this.db.prepare(
      "SELECT user_id, active_process_id, stack_json, next_seq, updated_at FROM user_state WHERE user_id = ?"
    ).bind(userId).first<StateRow>();

    const stack: string[] = state ? JSON.parse(state.stack_json) as string[] : [];
    const activeId = state?.active_process_id ?? null;
    const seq = state?.next_seq ?? 1;

    const statements: D1PreparedStatement[] = [];
    if (activeId) {
      statements.push(this.db.prepare("UPDATE intervals SET ended_at = ? WHERE process_id = ? AND ended_at IS NULL").bind(at, activeId));
      statements.push(this.db.prepare("UPDATE processes SET state = 'paused' WHERE id = ? AND user_id = ? AND state = 'running'").bind(activeId, userId));
      stack.push(activeId);
    }

    statements.push(this.db.prepare(
      "INSERT INTO processes (id,user_id,title,description,metadata_json,state,created_at,started_at,ended_at,created_seq) VALUES (?,?,?,?,?,'running',?,?,NULL,?)"
    ).bind(id, userId, title, description, metadata, at, at, seq));
    statements.push(this.db.prepare(
      "INSERT INTO intervals (id,process_id,started_at,ended_at) VALUES (?,?,?,NULL)"
    ).bind(intervalId, id, at));

    if (state) {
      statements.push(this.db.prepare(
        "UPDATE user_state SET active_process_id = ?, stack_json = ?, next_seq = ?, updated_at = ? WHERE user_id = ?"
      ).bind(id, JSON.stringify(stack), seq + 1, at, userId));
    } else {
      statements.push(this.db.prepare(
        "INSERT INTO user_state (user_id,active_process_id,stack_json,next_seq,updated_at) VALUES (?,?,?,?,?)"
      ).bind(userId, id, JSON.stringify(stack), seq + 1, at));
    }
    await this.db.batch(statements);

    return {
      id, userId, title, description, metadata: parseMeta(metadata),
      state: "running", createdAt: at, startedAt: at, endedAt: null, createdSeq: seq
    };
  }

  async stop(userId: string, at = Date.now()): Promise<ProcessRecord | null> {
    const state = await this.db.prepare(
      "SELECT user_id, active_process_id, stack_json, next_seq, updated_at FROM user_state WHERE user_id = ?"
    ).bind(userId).first<StateRow>();
    if (!state?.active_process_id) return null;

    const activeId = state.active_process_id;
    const stack: string[] = JSON.parse(state.stack_json) as string[];
    const resumedId = stack.pop() ?? null;

    const statements: D1PreparedStatement[] = [
      this.db.prepare("UPDATE intervals SET ended_at = ? WHERE process_id = ? AND ended_at IS NULL").bind(at, activeId),
      this.db.prepare("UPDATE processes SET state = 'stopped', ended_at = ? WHERE id = ? AND user_id = ? AND state = 'running'").bind(at, activeId, userId)
    ];

    if (resumedId) {
      statements.push(this.db.prepare("UPDATE processes SET state = 'running' WHERE id = ? AND user_id = ? AND state = 'paused'").bind(resumedId, userId));
      statements.push(this.db.prepare("INSERT INTO intervals (id,process_id,started_at,ended_at) VALUES (?,?,?,NULL)").bind(uid(), resumedId, at));
    }
    statements.push(this.db.prepare(
      "UPDATE user_state SET active_process_id = ?, stack_json = ?, updated_at = ? WHERE user_id = ?"
    ).bind(resumedId, JSON.stringify(stack), at, userId));

    await this.db.batch(statements);
    const row = await this.db.prepare("SELECT * FROM processes WHERE id = ?").bind(activeId).first<ProcessRow>();
    return row ? mapProcess(row) : null;
  }

  async report(userId: string, range: { from?: number; to?: number } = {}): Promise<Report> {
    const now = range.to ?? Date.now();
    const from = range.from ?? null;
    const overlap = from === null
      ? "i.started_at <= ?"
      : "i.started_at < ? AND COALESCE(i.ended_at, ?) > ?";
    const intervalRows = from === null
      ? await this.db.prepare(`SELECT i.* FROM intervals i JOIN processes p ON p.id=i.process_id WHERE p.user_id=? AND ${overlap}`)
          .bind(userId, now).all<IntervalRow>()
      : await this.db.prepare(`SELECT i.* FROM intervals i JOIN processes p ON p.id=i.process_id WHERE p.user_id=? AND ${overlap}`)
          .bind(userId, now, now, from).all<IntervalRow>();

    const allProcesses = await this.db.prepare(
      `SELECT p.*
       FROM processes p
       WHERE p.user_id = ?
       ORDER BY
         CASE
           WHEN p.id = (
             SELECT active_process_id
             FROM user_state
             WHERE user_id = p.user_id
           ) THEN 1
           ELSE 0
         END DESC,
         COALESCE(
           (SELECT MAX(COALESCE(i.ended_at, i.started_at))
            FROM intervals i
            WHERE i.process_id = p.id),
           p.ended_at,
           p.started_at
         ) DESC,
         p.created_seq DESC`
    ).bind(userId).all<ProcessRow>();

    const intervalsByProcess = new Map<string, IntervalRow[]>();
    for (const i of intervalRows.results ?? []) {
      const list = intervalsByProcess.get(i.process_id) ?? [];
      list.push(i);
      intervalsByProcess.set(i.process_id, list);
    }

    const selected = (allProcesses.results ?? []).map(mapProcess);
    const summaries: ProcessSummary[] = selected.map(p => {
      const allIntervals = intervalsByProcess.get(p.id) ?? [];
      const clipped = allIntervals.map(i => {
        const start = from === null ? i.started_at : Math.max(i.started_at, from);
        const end = Math.min(i.ended_at ?? now, now);
        return { id: i.id, processId: i.process_id, startedAt: start, endedAt: i.ended_at === null && end === now ? null : end } as IntervalRecord;
      }).filter(i => i.endedAt === null || i.endedAt >= i.startedAt);
      const activeDurationMs = clipped.reduce((sum, i) => sum + Math.max(0, (i.endedAt ?? now) - i.startedAt), 0);
      return {
        ...p, activeDurationMs,
        elapsedSinceStartMs: Math.max(0, now - Math.max(p.startedAt, from ?? p.startedAt)),
        intervals: clipped
      };
    });

    const completed = summaries.filter(p => p.state === "stopped" && p.endedAt !== null && p.endedAt >= (from ?? -Infinity) && p.startedAt <= now);
    const paused = summaries.filter(p => p.state === "paused" && p.startedAt <= now && (from === null || p.startedAt < now) );
    const pausedSorted = paused.sort((a,b) => a.startedAt - b.startedAt);
    const latest = summaries[0] ?? null;

    return {
      generatedAt: Date.now(),
      range: { from, to: now },
      completed: {
        count: completed.length,
        totalActiveDurationMs: completed.reduce((sum,p) => sum + p.activeDurationMs, 0)
      },
      paused: {
        count: pausedSorted.length,
        oldestFirstStartAt: pausedSorted[0]?.startedAt ?? null,
        oldestElapsedSinceStartMs: pausedSorted[0] ? Math.max(0, now - Math.max(pausedSorted[0].startedAt, from ?? pausedSorted[0].startedAt)) : null,
        processes: pausedSorted
      },
      latest
    };
  }
}

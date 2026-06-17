import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface OmxSessionHistoryItem {
  session_id: string;
  started_at: string;
  ended_at?: string;
  cwd?: string;
  pid?: number;
  log_path?: string;
  source_path: string;
}

export interface OmxEventLogRef {
  path: string;
  name: string;
  bytes: number;
  updated_at: string;
}

export interface OmxSubagentThreadSummary {
  thread_id: string;
  kind: 'leader' | 'subagent';
  active: boolean;
  turn_count: number;
  mode?: string;
  last_seen_at: string;
  completed_at?: string;
}

export interface OmxSubagentSessionSummary {
  session_id: string;
  leader_thread_id?: string;
  updated_at: string;
  total_threads: number;
  active_subagents: number;
  completed_subagents: number;
  threads: OmxSubagentThreadSummary[];
}

export interface OmxHistorySnapshot {
  sessions: OmxSessionHistoryItem[];
  eventLogs: OmxEventLogRef[];
  subagents: OmxSubagentSessionSummary[];
}

interface RawSessionHistoryRecord {
  session_id?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  cwd?: unknown;
  pid?: unknown;
}

interface RawSubagentThread {
  thread_id?: unknown;
  kind?: unknown;
  turn_count?: unknown;
  mode?: unknown;
  last_seen_at?: unknown;
  completed_at?: unknown;
}

interface RawSubagentSession {
  session_id?: unknown;
  leader_thread_id?: unknown;
  updated_at?: unknown;
  threads?: unknown;
}

const ACTIVE_SUBAGENT_WINDOW_MS = 120_000;

export async function listOmxHistory(cwd: string, maxItems = 24): Promise<OmxHistorySnapshot> {
  const [eventLogs, sessions, subagents] = await Promise.all([
    listEventLogs(cwd, maxItems),
    listSessionHistory(cwd, maxItems),
    listSubagentSummaries(cwd, maxItems),
  ]);

  return {
    sessions: attachNearestLogs(sessions, await listVscodeLogRefs(cwd, maxItems)),
    eventLogs,
    subagents,
  };
}

async function listSessionHistory(cwd: string, maxItems: number): Promise<OmxSessionHistoryItem[]> {
  const sourcePath = path.join(cwd, '.omx', 'logs', 'session-history.jsonl');
  if (!existsSync(sourcePath)) return [];

  const text = await readFile(sourcePath, 'utf8').catch(() => '');
  const sessions: OmxSessionHistoryItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseJsonRecord<RawSessionHistoryRecord>(line);
    const sessionId = asString(parsed?.session_id);
    const startedAt = asString(parsed?.started_at);
    if (!sessionId || !startedAt) continue;
    const pid = typeof parsed?.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : undefined;
    sessions.push({
      session_id: sessionId,
      started_at: startedAt,
      ...(asString(parsed?.ended_at) ? { ended_at: asString(parsed?.ended_at) } : {}),
      ...(asString(parsed?.cwd) ? { cwd: asString(parsed?.cwd) } : {}),
      ...(pid ? { pid } : {}),
      source_path: sourcePath,
    });
  }

  return sessions
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, maxItems);
}

async function listEventLogs(cwd: string, maxItems: number): Promise<OmxEventLogRef[]> {
  const dir = path.join(cwd, '.omx', 'logs');
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const logs: OmxEventLogRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const logPath = path.join(dir, entry.name);
    const info = await stat(logPath).catch(() => null);
    if (!info) continue;
    logs.push({
      path: logPath,
      name: entry.name,
      bytes: info.size,
      updated_at: info.mtime.toISOString(),
    });
  }
  return logs
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, maxItems);
}

async function listVscodeLogRefs(cwd: string, maxItems: number): Promise<OmxEventLogRef[]> {
  const dir = path.join(cwd, '.omx', 'logs', 'vscode');
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const logs: OmxEventLogRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const logPath = path.join(dir, entry.name);
    const info = await stat(logPath).catch(() => null);
    if (!info) continue;
    logs.push({
      path: logPath,
      name: entry.name,
      bytes: info.size,
      updated_at: info.mtime.toISOString(),
    });
  }
  return logs
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, maxItems);
}

function attachNearestLogs(
  sessions: OmxSessionHistoryItem[],
  logs: OmxEventLogRef[],
): OmxSessionHistoryItem[] {
  return sessions.map((session) => {
    const sessionTime = timestampFromId(session.session_id) ?? Date.parse(session.started_at);
    if (!Number.isFinite(sessionTime)) return session;
    const nearest = logs
      .map((log) => ({ log, distance: Math.abs((timestampFromId(log.name) ?? Date.parse(log.updated_at)) - sessionTime) }))
      .filter(({ distance }) => Number.isFinite(distance) && distance <= 60_000)
      .sort((a, b) => a.distance - b.distance)[0]?.log;
    return nearest ? { ...session, log_path: nearest.path } : session;
  });
}

async function listSubagentSummaries(cwd: string, maxItems: number): Promise<OmxSubagentSessionSummary[]> {
  const trackingPath = path.join(cwd, '.omx', 'state', 'subagent-tracking.json');
  if (!existsSync(trackingPath)) return [];
  const parsed = parseJsonRecord<{ sessions?: unknown }>(await readFile(trackingPath, 'utf8').catch(() => ''));
  if (!parsed?.sessions || typeof parsed.sessions !== 'object') return [];

  const now = Date.now();
  const summaries: OmxSubagentSessionSummary[] = [];
  for (const [sessionId, rawSession] of Object.entries(parsed.sessions as Record<string, unknown>)) {
    if (!rawSession || typeof rawSession !== 'object') continue;
    const session = rawSession as RawSubagentSession;
    const threadsObject = session.threads && typeof session.threads === 'object'
      ? session.threads as Record<string, unknown>
      : {};
    const threads: OmxSubagentThreadSummary[] = [];
    for (const [threadId, rawThread] of Object.entries(threadsObject)) {
      if (!rawThread || typeof rawThread !== 'object') continue;
      const thread = rawThread as RawSubagentThread;
      const normalizedThreadId = asString(thread.thread_id) ?? threadId;
      const kind = thread.kind === 'leader' ? 'leader' : 'subagent';
      const lastSeenAt = asString(thread.last_seen_at) ?? new Date(0).toISOString();
      const completedAt = asString(thread.completed_at);
      const active = kind === 'subagent' && !completedAt && now - Date.parse(lastSeenAt) <= ACTIVE_SUBAGENT_WINDOW_MS;
      threads.push({
        thread_id: normalizedThreadId,
        kind,
        active,
        turn_count: typeof thread.turn_count === 'number' && Number.isFinite(thread.turn_count) ? thread.turn_count : 0,
        ...(asString(thread.mode) ? { mode: asString(thread.mode) } : {}),
        last_seen_at: lastSeenAt,
        ...(completedAt ? { completed_at: completedAt } : {}),
      });
    }
    const subagentThreads = threads.filter((thread) => thread.kind === 'subagent');
    summaries.push({
      session_id: asString(session.session_id) ?? sessionId,
      ...(asString(session.leader_thread_id) ? { leader_thread_id: asString(session.leader_thread_id) } : {}),
      updated_at: asString(session.updated_at) ?? new Date(0).toISOString(),
      total_threads: threads.length,
      active_subagents: subagentThreads.filter((thread) => thread.active).length,
      completed_subagents: subagentThreads.filter((thread) => Boolean(thread.completed_at)).length,
      threads: threads
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
        .slice(0, 8),
    });
  }

  return summaries
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, maxItems);
}

function parseJsonRecord<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function timestampFromId(value: string): number | null {
  const match = /(?:^|[-_])(\d{13})(?:[-_.]|$)/.exec(value);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

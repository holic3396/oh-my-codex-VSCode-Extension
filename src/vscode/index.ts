import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import type { Dirent, Stats, WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactAuthSecrets } from '../auth/redact.js';
import { CODEX_BYPASS_FLAG, MADMAX_FLAG, MADMAX_SPARK_FLAG } from '../cli/constants.js';
import { readCurrentSessionId, getBaseStateDir } from '../mcp/state-paths.js';
import { collectSidecarSnapshot } from '../sidecar/collector.js';
import type { SidecarSnapshot } from '../sidecar/types.js';
import { monitorTeam, type TeamSnapshot } from '../team/runtime.js';
import { executeTeamApiOperation, resolveTeamApiOperation, type TeamApiEnvelope } from '../team/api-interop.js';
import { readAllState, readHudConfig } from '../hud/state.js';
import { renderHud } from '../hud/render.js';
import type { HudRenderContext } from '../hud/types.js';
import { isColorEnabled, setColorEnabled } from '../hud/colors.js';
import { resolveCommandPathForPlatform } from '../utils/platform-command.js';

export const VSCODE_LOG_SCHEMA_VERSION = 'omx.vscode/log/v1';
export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 'omx.vscode/workspace/v1';
export const DIRECT_SESSION_SCHEMA_VERSION = 'omx.vscode/direct-session/v1';
export const CONTROL_CENTER_SCHEMA_VERSION = 'omx.vscode/control-center/v1';
export const LOG_EXPLORER_SCHEMA_VERSION = 'omx.vscode/log-explorer/v1';

const DEFAULT_OMX_COMMAND = 'omx';
const LAUNCH_POLICY_ENV = 'OMX_LAUNCH_POLICY';
const VSCODE_RUNNER_ENV = 'OMX_VSCODE_RUNNER';
const VSCODE_SESSION_ENV = 'OMX_VSCODE_SESSION_ID';
const VSCODE_LOG_ENV = 'OMX_VSCODE_LOG_PATH';
const DIRECT_POLICY_FLAGS = new Set(['--direct', '--tmux']);
const DANGEROUS_FLAGS = new Set([
  MADMAX_FLAG,
  MADMAX_SPARK_FLAG,
  CODEX_BYPASS_FLAG,
  '--yolo',
]);
const LOG_FILE_EXTENSIONS = new Set(['.log', '.jsonl', '.txt', '.md']);
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_PREVIEW_CHARS = 1_200;
const MAX_LOG_SEARCH_RESULTS = 200;

export interface VscodeLogRef {
  schema_version: typeof VSCODE_LOG_SCHEMA_VERSION;
  path: string;
  name: string;
  bytes: number;
  updated_at: string;
}

export interface OmxWorkspaceSnapshot {
  schema_version: typeof WORKSPACE_SNAPSHOT_SCHEMA_VERSION;
  cwd: string;
  generated_at: string;
  state_dir: string;
  current_session_id?: string;
  hud: HudRenderContext;
  hud_text: string;
  logs: VscodeLogRef[];
  teams: Array<{
    name: string;
    path: string;
    updated_at: string;
  }>;
}

export interface ReadWorkspaceSnapshotOptions {
  cwd: string;
  maxLogs?: number;
  now?: Date;
}

export interface ReadTeamSnapshotOptions {
  cwd: string;
  teamName: string;
  refreshMonitor?: boolean;
}

export interface OmxTeamSnapshot {
  teamName: string;
  monitor: TeamSnapshot | null;
  sidecar: SidecarSnapshot | null;
}

export interface ReadSidecarSnapshotOptions {
  cwd: string;
  teamName: string;
  eventLimit?: number;
}

export interface TmuxPaneRef {
  id: string;
  session: string;
  window: string;
  pane: string;
  title: string;
  current_command: string;
  active: boolean;
}

export interface ListTmuxPanesOptions {
  cwd?: string;
}

export interface CaptureTmuxPaneTailOptions {
  target: string;
  lines?: number;
}

export interface TmuxPaneTail {
  target: string;
  lines: number;
  body: string;
  captured_at: string;
}

export interface SendTmuxPaneInputOptions {
  target: string;
  text: string;
  submit?: boolean;
}

export interface TmuxPaneInputResult {
  target: string;
  bytes: number;
  submitted: boolean;
}

export interface ControlCenterTeamSnapshot {
  name: string;
  updated_at: string;
  sidecar: SidecarSnapshot | null;
  monitor: TeamSnapshot | null;
}

export interface OmxControlCenterSnapshot {
  schema_version: typeof CONTROL_CENTER_SCHEMA_VERSION;
  generated_at: string;
  workspace: OmxWorkspaceSnapshot;
  teams: ControlCenterTeamSnapshot[];
  tmux: {
    available: boolean;
    panes: TmuxPaneRef[];
    error?: string;
  };
}

export interface ReadControlCenterSnapshotOptions {
  cwd: string;
  maxLogs?: number;
  refreshMonitor?: boolean;
  eventLimit?: number;
  now?: Date;
}

export interface OmxLogEntry {
  id: string;
  path: string;
  name: string;
  source: 'vscode' | 'omx' | 'team-events' | 'session-history' | 'state' | 'other';
  bytes: number;
  updated_at: string;
  line?: number;
  timestamp?: string;
  level?: string;
  session_id?: string;
  team?: string;
  worker?: string;
  task_id?: string;
  message: string;
  preview: string;
}

export interface OmxLogSearchFilters {
  query?: string;
  source?: OmxLogEntry['source'] | 'all';
  team?: string;
  worker?: string;
  task_id?: string;
  session_id?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface OmxLogExplorerSnapshot {
  schema_version: typeof LOG_EXPLORER_SCHEMA_VERSION;
  cwd: string;
  generated_at: string;
  logs: Array<{
    path: string;
    name: string;
    source: OmxLogEntry['source'];
    bytes: number;
    updated_at: string;
  }>;
  teams: OmxWorkspaceSnapshot['teams'];
  recent: OmxLogEntry[];
}

export interface ReadLogExplorerSnapshotOptions {
  cwd: string;
  limit?: number;
  now?: Date;
}

export interface SearchOmxLogsOptions extends OmxLogSearchFilters {
  cwd: string;
}

export interface RunOmxCatalogCommandOptions {
  cwd: string;
  omxCommand?: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunOmxCatalogCommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type DirectSessionMode = 'launch' | 'resume';

export interface BuildDirectSessionArgsOptions {
  mode?: DirectSessionMode;
  codexArgs?: string[];
}

export interface LaunchDirectSessionOptions extends BuildDirectSessionArgsOptions {
  cwd: string;
  prompt?: string;
  omxCommand?: string;
  env?: NodeJS.ProcessEnv;
  dangerousApproved?: boolean;
  logPath?: string;
  sessionId?: string;
}

export interface ResolveVscodeLaunchEnvOptions {
  cwd: string;
  omxCommand?: string;
  baseEnv?: NodeJS.ProcessEnv;
  extraPath?: string[];
  platform?: NodeJS.Platform;
}

export interface VscodeLaunchEnvResolution {
  env: NodeJS.ProcessEnv;
  pathKey: string;
  pathEntries: string[];
  codexPath: string | null;
}

export interface OmxDirectSessionHandle {
  schema_version: typeof DIRECT_SESSION_SCHEMA_VERSION;
  session_id: string;
  cwd: string;
  command: string;
  args: string[];
  pid?: number;
  log_path: string;
  started_at: string;
  child: ChildProcess;
  stop: (signal?: NodeJS.Signals | number) => boolean;
}

interface LaunchDirectSessionDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => Date;
  randomId?: () => string;
}

function normalizeCwd(cwd: string): string {
  const normalized = cwd.trim();
  if (!normalized) throw new Error('cwd is required');
  return resolve(normalized);
}

function stripPolicyFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !DIRECT_POLICY_FLAGS.has(arg));
}

function dedupePathEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function resolvePathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function defaultVscodePathEntries(
  cwd: string,
  omxCommand: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  const entries = [
    isAbsolute(omxCommand ?? '') ? dirname(omxCommand as string) : '',
    join(cwd, 'node_modules', '.bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global', 'bin'),
  ];

  if (platform === 'darwin') {
    entries.push('/Applications/Codex.app/Contents/Resources');
  }
  if (platform !== 'win32') {
    entries.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  }

  return entries;
}

export function resolveVscodeLaunchEnv(options: ResolveVscodeLaunchEnvOptions): VscodeLaunchEnvResolution {
  const cwd = normalizeCwd(options.cwd);
  const platform = options.platform ?? process.platform;
  const baseEnv = options.baseEnv ?? process.env;
  const pathKey = resolvePathKey(baseEnv);
  const currentPathEntries = String(baseEnv[pathKey] ?? baseEnv.PATH ?? baseEnv.Path ?? '')
    .split(delimiter)
    .filter(Boolean);
  const pathEntries = dedupePathEntries([
    ...(options.extraPath ?? []),
    ...defaultVscodePathEntries(cwd, options.omxCommand, platform),
    ...currentPathEntries,
  ]);
  const mergedPath = pathEntries.join(delimiter);
  const env = {
    ...baseEnv,
    [pathKey]: mergedPath,
    PATH: mergedPath,
  };

  return {
    env,
    pathKey,
    pathEntries,
    codexPath: resolveCommandPathForPlatform('codex', platform, env),
  };
}

export function buildDirectSessionArgs(options: BuildDirectSessionArgsOptions = {}): string[] {
  const mode = options.mode ?? 'launch';
  const codexArgs = stripPolicyFlags(options.codexArgs ?? []);
  return mode === 'resume'
    ? ['resume', '--direct', ...codexArgs]
    : ['launch', '--direct', ...codexArgs];
}

export function findDangerousLaunchArgs(args: readonly string[]): string[] {
  return args.filter((arg) => DANGEROUS_FLAGS.has(arg));
}

export function launchRequiresDangerousApproval(args: readonly string[]): boolean {
  return findDangerousLaunchArgs(args).length > 0;
}

export function redactOmxLogLine(value: unknown): string {
  return redactAuthSecrets(value);
}

function defaultSessionId(now: Date = new Date()): string {
  const suffix = randomBytes(4).toString('hex');
  return `vscode-${now.getTime()}-${suffix}`;
}

function vscodeLogDir(cwd: string): string {
  return join(cwd, '.omx', 'logs', 'vscode');
}

function defaultLogPath(cwd: string, sessionId: string): string {
  return join(vscodeLogDir(cwd), `${sessionId}.log`);
}

function ensureLogStream(path: string): WriteStream {
  mkdirSync(resolve(path, '..'), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
}

function writeLog(stream: WriteStream, text: string): void {
  stream.write(redactOmxLogLine(text));
}

function resolveLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionId: string,
  logPath: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [LAUNCH_POLICY_ENV]: 'direct',
    [VSCODE_RUNNER_ENV]: '1',
    [VSCODE_SESSION_ENV]: sessionId,
    [VSCODE_LOG_ENV]: logPath,
  };
}

export function launchDirectSession(
  options: LaunchDirectSessionOptions,
  deps: LaunchDirectSessionDeps = {},
): OmxDirectSessionHandle {
  const cwd = normalizeCwd(options.cwd);
  const now = deps.now?.() ?? new Date();
  const sessionId = options.sessionId ?? deps.randomId?.() ?? defaultSessionId(now);
  const command = options.omxCommand?.trim() || DEFAULT_OMX_COMMAND;
  const promptArg = typeof options.prompt === 'string' && options.prompt.trim() !== ''
    ? [options.prompt]
    : [];
  const args = buildDirectSessionArgs({
    mode: options.mode,
    codexArgs: [...(options.codexArgs ?? []), ...promptArg],
  });
  const dangerousArgs = findDangerousLaunchArgs(args);
  if (dangerousArgs.length > 0 && options.dangerousApproved !== true) {
    throw new Error(`dangerous_launch_requires_approval:${dangerousArgs.join(',')}`);
  }

  const logPath = options.logPath ? resolve(options.logPath) : defaultLogPath(cwd, sessionId);
  const logStream = ensureLogStream(logPath);
  const env = resolveLaunchEnv(options.env ?? process.env, sessionId, logPath);
  const spawnOptions: SpawnOptions = {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const child = (deps.spawn ?? nodeSpawn)(command, args, spawnOptions);
  const startedAt = now.toISOString();
  writeLog(logStream, `[${startedAt}] $ ${command} ${args.join(' ')}\n`);

  child.stdout?.on('data', (chunk: Buffer | string) => writeLog(logStream, String(chunk)));
  child.stderr?.on('data', (chunk: Buffer | string) => writeLog(logStream, String(chunk)));
  child.on('error', (error) => {
    writeLog(logStream, `\n[${new Date().toISOString()}] launch error: ${redactOmxLogLine(error)}\n`);
  });
  child.on('exit', (code, signal) => {
    writeLog(logStream, `\n[${new Date().toISOString()}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    logStream.end();
  });

  return {
    schema_version: DIRECT_SESSION_SCHEMA_VERSION,
    session_id: sessionId,
    cwd,
    command,
    args,
    pid: child.pid,
    log_path: logPath,
    started_at: startedAt,
    child,
    stop: (signal: NodeJS.Signals | number = 'SIGTERM') => child.kill(signal),
  };
}

function listVscodeLogs(cwd: string, maxLogs: number): VscodeLogRef[] {
  const dir = vscodeLogDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      return {
        schema_version: VSCODE_LOG_SCHEMA_VERSION as typeof VSCODE_LOG_SCHEMA_VERSION,
        path,
        name,
        bytes: stat.size,
        updated_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, maxLogs);
}

function listTeamRefs(cwd: string): OmxWorkspaceSnapshot['teams'] {
  const teamRoot = join(getBaseStateDir(cwd), 'team');
  if (!existsSync(teamRoot)) return [];
  return readdirSync(teamRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(teamRoot, entry.name);
      const stat = statSync(path);
      return {
        name: entry.name,
        path,
        updated_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readTailSync(path: string, maxBytes = MAX_LOG_FILE_BYTES): string {
  const info = safeStat(path);
  if (!info?.isFile()) return '';
  const bytesToRead = Math.min(info.size, Math.max(1, maxBytes));
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, bytesToRead, Math.max(0, info.size - bytesToRead));
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function walkFiles(root: string, maxDepth = 5): string[] {
  if (!existsSync(root) || maxDepth < 0) return [];
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth < 0) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth - 1);
      } else if (entry.isFile() && LOG_FILE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.ndjson')) {
        files.push(path);
      }
    }
  };
  visit(root, maxDepth);
  return files;
}

function classifyLogSource(path: string): OmxLogEntry['source'] {
  const normalized = path.split(sep).join('/');
  if (normalized.includes('/.omx/logs/vscode/')) return 'vscode';
  if (normalized.endsWith('/session-history.jsonl')) return 'session-history';
  if (normalized.includes('/.omx/state/team/') && normalized.includes('/events/')) return 'team-events';
  if (normalized.includes('/.omx/logs/')) return 'omx';
  if (normalized.includes('/.omx/state/')) return 'state';
  return 'other';
}

function discoverLogFiles(cwd: string): OmxLogExplorerSnapshot['logs'] {
  const normalizedCwd = normalizeCwd(cwd);
  const roots = [
    join(normalizedCwd, '.omx', 'logs'),
    join(normalizedCwd, '.omx', 'state', 'team'),
  ];
  const seen = new Set<string>();
  const logs: OmxLogExplorerSnapshot['logs'] = [];
  for (const root of roots) {
    for (const path of walkFiles(root, 7)) {
      if (seen.has(path) || !isPathInside(path, normalizedCwd)) continue;
      seen.add(path);
      const info = safeStat(path);
      if (!info?.isFile()) continue;
      logs.push({
        path,
        name: relative(normalizedCwd, path),
        source: classifyLogSource(path),
        bytes: info.size,
        updated_at: info.mtime.toISOString(),
      });
    }
  }
  return logs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function truncatePreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_LOG_PREVIEW_CHARS
    ? `${compact.slice(0, MAX_LOG_PREVIEW_CHARS - 1)}…`
    : compact;
}

function asLogString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeLogRecord(
  log: OmxLogExplorerSnapshot['logs'][number],
  line: string,
  lineNumber: number,
): OmxLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: Record<string, unknown> | null = null;
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      parsed = null;
    }
  }

  const timestamp = asLogString(parsed?.created_at)
    ?? asLogString(parsed?.timestamp)
    ?? asLogString(parsed?.time)
    ?? asLogString(parsed?.started_at)
    ?? asLogString(parsed?.updated_at);
  const message = asLogString(parsed?.message)
    ?? asLogString(parsed?.body)
    ?? asLogString(parsed?.event)
    ?? asLogString(parsed?.type)
    ?? trimmed;
  const team = asLogString(parsed?.team)
    ?? asLogString(parsed?.team_name)
    ?? inferTeamFromPath(log.path);
  const worker = asLogString(parsed?.worker)
    ?? asLogString(parsed?.worker_name)
    ?? asLogString(parsed?.from_worker)
    ?? asLogString(parsed?.to_worker);
  const taskId = asLogString(parsed?.task_id);
  const sessionId = asLogString(parsed?.session_id) ?? inferSessionIdFromPath(log.path);
  return {
    id: `${log.path}:${lineNumber}`,
    path: log.path,
    name: log.name,
    source: log.source,
    bytes: log.bytes,
    updated_at: log.updated_at,
    line: lineNumber,
    ...(timestamp ? { timestamp } : {}),
    ...(asLogString(parsed?.level) ? { level: asLogString(parsed?.level) } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(team ? { team } : {}),
    ...(worker ? { worker } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    message,
    preview: truncatePreview(message),
  };
}

function inferTeamFromPath(path: string): string | undefined {
  const parts = path.split(sep);
  const teamIndex = parts.lastIndexOf('team');
  return teamIndex >= 0 ? parts[teamIndex + 1] : undefined;
}

function inferSessionIdFromPath(path: string): string | undefined {
  const name = basename(path);
  const withoutExtension = name.replace(/\.(?:log|jsonl|txt|md|ndjson)$/i, '');
  return withoutExtension.startsWith('vscode-') || withoutExtension.startsWith('omx-')
    ? withoutExtension
    : undefined;
}

function matchesLogFilters(entry: OmxLogEntry, filters: OmxLogSearchFilters): boolean {
  if (filters.source && filters.source !== 'all' && entry.source !== filters.source) return false;
  if (filters.team && entry.team !== filters.team) return false;
  if (filters.worker && entry.worker !== filters.worker) return false;
  if (filters.task_id && entry.task_id !== filters.task_id) return false;
  if (filters.session_id && entry.session_id !== filters.session_id) return false;
  const timestampMs = Date.parse(entry.timestamp ?? entry.updated_at);
  if (filters.since && Number.isFinite(timestampMs) && timestampMs < Date.parse(filters.since)) return false;
  if (filters.until && Number.isFinite(timestampMs) && timestampMs > Date.parse(filters.until)) return false;
  const query = filters.query?.trim().toLowerCase();
  if (query) {
    const haystack = [
      entry.message,
      entry.preview,
      entry.name,
      entry.source,
      entry.team,
      entry.worker,
      entry.task_id,
      entry.session_id,
    ].filter(Boolean).join('\n').toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function collectLogEntries(cwd: string, filters: OmxLogSearchFilters = {}): OmxLogEntry[] {
  const limit = Math.min(Math.max(1, filters.limit ?? MAX_LOG_SEARCH_RESULTS), MAX_LOG_SEARCH_RESULTS);
  const entries: OmxLogEntry[] = [];
  for (const log of discoverLogFiles(cwd)) {
    const text = readTailSync(log.path);
    const lines = text.split(/\r?\n/);
    const firstLineNumber = Math.max(1, Math.max(0, lines.length - 5_000));
    const visibleLines = lines.slice(-5_000);
    for (let index = visibleLines.length - 1; index >= 0; index -= 1) {
      const entry = normalizeLogRecord(log, visibleLines[index] ?? '', firstLineNumber + index);
      if (!entry || !matchesLogFilters(entry, filters)) continue;
      entries.push(entry);
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = nodeSpawnSync('tmux', args, { encoding: 'utf8' });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: String(result.stderr || `tmux exited ${result.status}`) };
  return { ok: true, stdout: String(result.stdout ?? '') };
}

export function listTmuxPanes(_options: ListTmuxPanesOptions = {}): TmuxPaneRef[] {
  const format = [
    '#{pane_id}',
    '#{session_name}',
    '#{window_index}',
    '#{pane_index}',
    '#{pane_title}',
    '#{pane_current_command}',
    '#{pane_active}',
  ].join('\t');
  const result = runTmux(['list-panes', '-a', '-F', format]);
  if (!result.ok) throw new Error(result.error);
  return result.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', session = '', window = '', pane = '', title = '', currentCommand = '', active = '0'] = line.split('\t');
      return {
        id,
        session,
        window,
        pane,
        title,
        current_command: currentCommand,
        active: active === '1',
      };
    });
}

export function captureTmuxPaneTail(options: CaptureTmuxPaneTailOptions): TmuxPaneTail {
  const target = options.target.trim();
  if (!target) throw new Error('target is required');
  const lines = Math.min(Math.max(20, options.lines ?? 120), 1_000);
  const result = runTmux(['capture-pane', '-t', target, '-p', '-S', `-${lines}`]);
  if (!result.ok) throw new Error(result.error);
  return {
    target,
    lines,
    body: result.stdout,
    captured_at: new Date().toISOString(),
  };
}

export function sendTmuxPaneInput(options: SendTmuxPaneInputOptions): TmuxPaneInputResult {
  const target = options.target.trim();
  const text = options.text.trim();
  if (!target) throw new Error('target is required');
  if (!text) throw new Error('text is required');
  const normalized = text.replace(/[\r\n]+/g, ' ');
  const typed = runTmux(['send-keys', '-t', target, '-l', normalized]);
  if (!typed.ok) throw new Error(typed.error);
  if (options.submit !== false) {
    const submitted = runTmux(['send-keys', '-t', target, 'C-m']);
    if (!submitted.ok) throw new Error(submitted.error);
  }
  return {
    target,
    bytes: Buffer.byteLength(normalized, 'utf8'),
    submitted: options.submit !== false,
  };
}

export async function readSidecarSnapshot(options: ReadSidecarSnapshotOptions): Promise<SidecarSnapshot | null> {
  return collectSidecarSnapshot(options.teamName, {
    cwd: normalizeCwd(options.cwd),
    eventLimit: options.eventLimit,
  });
}

export async function readControlCenterSnapshot(options: ReadControlCenterSnapshotOptions): Promise<OmxControlCenterSnapshot> {
  const cwd = normalizeCwd(options.cwd);
  const workspace = await readWorkspaceSnapshot({
    cwd,
    maxLogs: options.maxLogs,
    now: options.now,
  });
  const teams = await Promise.all(workspace.teams.map(async (team) => {
    const [sidecar, monitor] = await Promise.all([
      collectSidecarSnapshot(team.name, { cwd, eventLimit: options.eventLimit }),
      options.refreshMonitor ? monitorTeam(team.name, cwd).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      name: team.name,
      updated_at: team.updated_at,
      sidecar,
      monitor,
    };
  }));
  let tmux: OmxControlCenterSnapshot['tmux'];
  try {
    tmux = { available: true, panes: listTmuxPanes({ cwd }) };
  } catch (error) {
    tmux = {
      available: false,
      panes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    schema_version: CONTROL_CENTER_SCHEMA_VERSION,
    generated_at: (options.now ?? new Date()).toISOString(),
    workspace,
    teams,
    tmux,
  };
}

export async function readLogExplorerSnapshot(options: ReadLogExplorerSnapshotOptions): Promise<OmxLogExplorerSnapshot> {
  const cwd = normalizeCwd(options.cwd);
  return {
    schema_version: LOG_EXPLORER_SCHEMA_VERSION,
    cwd,
    generated_at: (options.now ?? new Date()).toISOString(),
    logs: discoverLogFiles(cwd),
    teams: listTeamRefs(cwd),
    recent: collectLogEntries(cwd, { limit: options.limit ?? 50 }),
  };
}

export async function searchOmxLogs(options: SearchOmxLogsOptions): Promise<OmxLogEntry[]> {
  return collectLogEntries(normalizeCwd(options.cwd), options);
}

export async function runTeamApiForVscode(
  cwd: string,
  operationName: string,
  input: Record<string, unknown>,
): Promise<TeamApiEnvelope> {
  const operation = resolveTeamApiOperation(operationName);
  if (!operation) {
    return {
      ok: false,
      operation: 'unknown',
      error: { code: 'invalid_operation', message: `Unknown team API operation: ${operationName}` },
    };
  }
  return executeTeamApiOperation(operation, input, normalizeCwd(cwd));
}

export function runOmxCatalogCommand(options: RunOmxCatalogCommandOptions): RunOmxCatalogCommandResult {
  const cwd = normalizeCwd(options.cwd);
  const command = options.omxCommand?.trim() || DEFAULT_OMX_COMMAND;
  const result = nodeSpawnSync(command, options.args, {
    cwd,
    env: { ...(options.env ?? process.env), [LAUNCH_POLICY_ENV]: 'direct', [VSCODE_RUNNER_ENV]: '1' },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
  });
  return {
    command,
    args: [...options.args],
    stdout: String(result.stdout ?? ''),
    stderr: result.error ? result.error.message : String(result.stderr ?? ''),
    code: typeof result.status === 'number' ? result.status : null,
    signal: result.signal as NodeJS.Signals | null,
  };
}

export async function readWorkspaceSnapshot(
  optionsOrCwd: ReadWorkspaceSnapshotOptions | string,
): Promise<OmxWorkspaceSnapshot> {
  const options = typeof optionsOrCwd === 'string' ? { cwd: optionsOrCwd } : optionsOrCwd;
  const cwd = normalizeCwd(options.cwd);
  const config = await readHudConfig(cwd);
  const hud = await readAllState(cwd, config);
  const currentSessionId = await readCurrentSessionId(cwd);
  const colorWasEnabled = isColorEnabled();
  setColorEnabled(false);
  let hudText: string;
  try {
    hudText = renderHud(hud, config.preset);
  } finally {
    setColorEnabled(colorWasEnabled);
  }
  return {
    schema_version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
    cwd,
    generated_at: (options.now ?? new Date()).toISOString(),
    state_dir: getBaseStateDir(cwd),
    ...(currentSessionId ? { current_session_id: currentSessionId } : {}),
    hud,
    hud_text: hudText,
    logs: listVscodeLogs(cwd, options.maxLogs ?? 20),
    teams: listTeamRefs(cwd),
  };
}

export async function readTeamSnapshot(options: ReadTeamSnapshotOptions): Promise<OmxTeamSnapshot> {
  const cwd = normalizeCwd(options.cwd);
  const [sidecar, monitor] = await Promise.all([
    collectSidecarSnapshot(options.teamName, { cwd }),
    options.refreshMonitor ? monitorTeam(options.teamName, cwd) : Promise.resolve(null),
  ]);
  return {
    teamName: options.teamName,
    sidecar,
    monitor,
  };
}

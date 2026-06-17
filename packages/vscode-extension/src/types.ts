import type { ChildProcess } from 'node:child_process';

export interface VscodeLogRef {
  path: string;
  name: string;
  bytes: number;
  updated_at: string;
}

export interface WorkspaceTeamRef {
  name: string;
  path: string;
  updated_at: string;
}

export interface WorkspaceSnapshot {
  schema_version: string;
  cwd: string;
  generated_at: string;
  state_dir: string;
  current_session_id?: string;
  hud?: Record<string, unknown>;
  hud_text: string;
  logs: VscodeLogRef[];
  teams: WorkspaceTeamRef[];
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

export interface SidecarTask {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner?: string;
  role?: string;
  result?: string;
  error?: string;
  blocked_by?: string[];
  depends_on?: string[];
  version?: number;
  claim?: { owner: string; leased_until: string };
  created_at?: string;
  completed_at?: string;
}

export interface SidecarWorkerSnapshot {
  name: string;
  index: number;
  role: string;
  assigned_tasks: string[];
  pane_id?: string;
  worker_cli?: string;
  working_dir?: string;
  worktree_path?: string;
  worktree_branch?: string;
  status: {
    state: string;
    current_task_id?: string;
    reason?: string;
    updated_at?: string;
  };
  heartbeat: {
    pid?: number;
    last_turn_at?: string;
    turn_count?: number;
    alive?: boolean;
  } | null;
  alive: boolean | null;
  current_task: SidecarTask | null;
  turns_without_progress: number | null;
}

export interface SidecarSnapshot {
  schema_version: string;
  generated_at: string;
  team_name: string;
  team_task: string;
  phase: string | null;
  topology: {
    summary: string;
    nodes: string[];
    edges: Array<{ from: string; to: string; label?: string }>;
  };
  workers: SidecarWorkerSnapshot[];
  tasks: SidecarTask[];
  events: Array<{
    event_id: string;
    team: string;
    type: string;
    worker: string;
    task_id?: string;
    state?: string;
    prev_state?: string;
    reason?: string;
    source_type?: string;
    created_at: string;
  }>;
  panes: Array<{ target: string; pane_id: string; role: 'leader' | 'hud' | 'worker' }>;
  highlights: Array<{ severity: 'info' | 'warning' | 'critical'; target: string; kind: string; message: string }>;
  source_warnings: string[];
}

export interface ControlCenterSnapshot {
  schema_version: string;
  generated_at: string;
  workspace: WorkspaceSnapshot;
  teams: Array<{
    name: string;
    updated_at: string;
    sidecar: SidecarSnapshot | null;
    monitor: unknown;
  }>;
  tmux: {
    available: boolean;
    panes: TmuxPaneRef[];
    error?: string;
  };
}

export interface LogEntry {
  id: string;
  path: string;
  name: string;
  source: string;
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

export interface LogExplorerSnapshot {
  schema_version: string;
  cwd: string;
  generated_at: string;
  logs: Array<{
    path: string;
    name: string;
    source: string;
    bytes: number;
    updated_at: string;
  }>;
  teams: WorkspaceTeamRef[];
  recent: LogEntry[];
}

export interface DirectSessionHandle {
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

export interface OmxCore {
  buildDirectSessionArgs(options?: { mode?: 'launch' | 'resume'; codexArgs?: string[] }): string[];
  resolveVscodeLaunchEnv(options: {
    cwd: string;
    omxCommand?: string;
    baseEnv?: NodeJS.ProcessEnv;
    extraPath?: string[];
  }): {
    env: NodeJS.ProcessEnv;
    pathKey: string;
    pathEntries: string[];
    codexPath: string | null;
  };
  launchDirectSession(options: {
    cwd: string;
    mode?: 'launch' | 'resume';
    prompt?: string;
    codexArgs?: string[];
    omxCommand?: string;
    dangerousApproved?: boolean;
    env?: NodeJS.ProcessEnv;
  }): DirectSessionHandle;
  launchRequiresDangerousApproval(args: readonly string[]): boolean;
  readWorkspaceSnapshot(options: { cwd: string; maxLogs?: number }): Promise<WorkspaceSnapshot>;
  readTeamSnapshot(options: { cwd: string; teamName: string; refreshMonitor?: boolean }): Promise<unknown>;
  readControlCenterSnapshot(options: { cwd: string; maxLogs?: number; refreshMonitor?: boolean; eventLimit?: number }): Promise<ControlCenterSnapshot>;
  readLogExplorerSnapshot(options: { cwd: string; limit?: number }): Promise<LogExplorerSnapshot>;
  searchOmxLogs(options: {
    cwd: string;
    query?: string;
    source?: string;
    team?: string;
    worker?: string;
    task_id?: string;
    session_id?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<LogEntry[]>;
  readSidecarSnapshot(options: { cwd: string; teamName: string; eventLimit?: number }): Promise<SidecarSnapshot | null>;
  listTmuxPanes(options?: { cwd?: string }): TmuxPaneRef[];
  captureTmuxPaneTail(options: { target: string; lines?: number }): {
    target: string;
    lines: number;
    body: string;
    captured_at: string;
  };
  sendTmuxPaneInput(options: { target: string; text: string; submit?: boolean }): {
    target: string;
    bytes: number;
    submitted: boolean;
  };
  runOmxCatalogCommand(options: {
    cwd: string;
    omxCommand?: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): {
    command: string;
    args: string[];
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  };
  runTeamApiForVscode(cwd: string, operationName: string, input: Record<string, unknown>): Promise<unknown>;
}

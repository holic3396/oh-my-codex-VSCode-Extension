import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadOmxCore } from './core';
import type { DirectSessionHandle, OmxCore } from './types';

type OutputStreamName = 'stdout' | 'stderr';

interface SessionRunCallbacks {
  onOutput?: (stream: OutputStreamName, text: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
}

export interface OmxCommandResult {
  session_id: string;
  command: string;
  args: string[];
  pid?: number;
  log_path: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class OmxSessionManager {
  private activeSession: DirectSessionHandle | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly onDidChange: () => void,
  ) {}

  get active(): DirectSessionHandle | null {
    return this.activeSession;
  }

  async start(
    mode: 'launch' | 'resume',
    prompt?: string,
    callbacks: SessionRunCallbacks = {},
  ): Promise<DirectSessionHandle | null> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const config = vscode.workspace.getConfiguration('omx');
    const omxCommand = resolveOmxCommand(cwd);
    const launchEnv = resolveOmxLaunchEnv(core, cwd, omxCommand);
    const codexArgs = config.get<string[]>('defaultArgs') ?? [];
    const launchArgs = core.buildDirectSessionArgs({ mode, codexArgs: [...codexArgs, ...(prompt ? [prompt] : [])] });
    const needsApproval = core.launchRequiresDangerousApproval(launchArgs);
    let dangerousApproved = false;

    if (needsApproval && config.get<boolean>('confirmDangerousLaunches', true)) {
      const choice = await vscode.window.showWarningMessage(
        `OMX will launch with dangerous approval-bypass flags: ${launchArgs.join(' ')}`,
        { modal: true },
        'Launch',
      );
      if (choice !== 'Launch') return null;
      dangerousApproved = true;
    } else {
      dangerousApproved = needsApproval;
    }

    const handle = core.launchDirectSession({
      cwd,
      mode,
      prompt,
      codexArgs,
      omxCommand,
      dangerousApproved,
      env: launchEnv.env,
    });
    this.activeSession = handle;
    this.output.show(true);
    this.output.appendLine(`[omx] started ${mode} session ${handle.session_id}`);
    this.output.appendLine(`[omx] log: ${handle.log_path}`);
    handle.child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      this.output.append(text);
      callbacks.onOutput?.('stdout', text);
    });
    handle.child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      this.output.append(text);
      callbacks.onOutput?.('stderr', text);
    });
    handle.child.on('exit', (code, signal) => {
      this.output.appendLine(`\n[omx] session ${handle.session_id} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      callbacks.onExit?.(code, signal);
      if (this.activeSession?.session_id === handle.session_id) {
        this.activeSession = null;
        this.onDidChange();
      }
    });
    handle.child.on('error', (error) => {
      this.output.appendLine(`[omx] launch error: ${error instanceof Error ? error.message : String(error)}`);
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (this.activeSession?.session_id === handle.session_id) {
        this.activeSession = null;
        this.onDidChange();
      }
    });
    this.onDidChange();
    return handle;
  }

  async exec(prompt: string, callbacks: SessionRunCallbacks = {}): Promise<DirectSessionHandle> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const config = vscode.workspace.getConfiguration('omx');
    const omxCommand = resolveOmxCommand(cwd);
    const launchEnv = resolveOmxLaunchEnv(core, cwd, omxCommand);
    const codexArgs = config.get<string[]>('defaultArgs') ?? [];
    const sessionId = `vscode-exec-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const args = ['exec', ...codexArgs, prompt];
    const logPath = vscodeLogPath(cwd, sessionId);
    const logStream = openLogStream(logPath);
    const child = spawn(omxCommand, args, {
      cwd,
      env: { ...launchEnv.env, OMX_LAUNCH_POLICY: 'direct', OMX_VSCODE_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle: DirectSessionHandle = {
      session_id: sessionId,
      cwd,
      command: omxCommand,
      args,
      pid: child.pid,
      log_path: logPath,
      started_at: new Date().toISOString(),
      child,
      stop: (signal: NodeJS.Signals | number = 'SIGTERM') => child.kill(signal),
    };

    this.activeSession = handle;
    this.output.show(true);
    this.output.appendLine(`[omx] started exec session ${handle.session_id}`);
    this.output.appendLine(`[omx] log: ${handle.log_path}`);
    writeLog(logStream, `[${handle.started_at}] $ ${omxCommand} ${args.join(' ')}\n`);

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      this.output.append(text);
      writeLog(logStream, text);
      callbacks.onOutput?.('stdout', text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      this.output.append(text);
      writeLog(logStream, text);
      callbacks.onOutput?.('stderr', text);
    });
    child.on('error', (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.output.appendLine(`[omx] exec launch error: ${err.message}`);
      writeLog(logStream, `\n[${new Date().toISOString()}] launch error: ${err.message}\n`);
      callbacks.onError?.(err);
      if (this.activeSession?.session_id === handle.session_id) {
        this.activeSession = null;
        this.onDidChange();
      }
    });
    child.on('exit', (code, signal) => {
      const exitLine = `\n[omx] exec session ${handle.session_id} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.output.appendLine(exitLine);
      writeLog(logStream, `\n[${new Date().toISOString()}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
      logStream.end();
      callbacks.onExit?.(code, signal);
      if (this.activeSession?.session_id === handle.session_id) {
        this.activeSession = null;
        this.onDidChange();
      }
    });
    this.onDidChange();
    return handle;
  }

  async injectExecFollowup(
    sessionId: string,
    prompt: string,
    callbacks: SessionRunCallbacks = {},
  ): Promise<OmxCommandResult> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const omxCommand = resolveOmxCommand(cwd);
    const launchEnv = resolveOmxLaunchEnv(core, cwd, omxCommand);
    const runId = `vscode-inject-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const args = ['exec', 'inject', sessionId, '--prompt', prompt, '--actor', 'vscode', '--json'];
    return this.runOmxCommand(cwd, omxCommand, args, launchEnv.env, runId, callbacks);
  }

  async runCommand(
    args: string[],
    runIdPrefix = 'vscode-command',
    callbacks: SessionRunCallbacks = {},
  ): Promise<OmxCommandResult> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const omxCommand = resolveOmxCommand(cwd);
    const launchEnv = resolveOmxLaunchEnv(core, cwd, omxCommand);
    const safePrefix = runIdPrefix.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48) || 'vscode-command';
    const runId = `${safePrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return this.runOmxCommand(cwd, omxCommand, args, launchEnv.env, runId, callbacks);
  }

  async currentOmxSessionId(): Promise<string | null> {
    try {
      const cwd = getWorkspaceRoot();
      const core = await loadOmxCore(this.context);
      const snapshot = await core.readWorkspaceSnapshot({ cwd, maxLogs: 1 });
      return snapshot.current_session_id ?? null;
    } catch {
      return null;
    }
  }

  private runOmxCommand(
    cwd: string,
    omxCommand: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    runId: string,
    callbacks: SessionRunCallbacks = {},
  ): Promise<OmxCommandResult> {
    const logPath = vscodeLogPath(cwd, runId);
    const logStream = openLogStream(logPath);
    const startedAt = new Date().toISOString();
    const child = spawn(omxCommand, args, {
      cwd,
      env: { ...env, OMX_LAUNCH_POLICY: 'direct', OMX_VSCODE_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    this.output.show(true);
    this.output.appendLine(`[omx] $ ${omxCommand} ${args.join(' ')}`);
    this.output.appendLine(`[omx] log: ${logPath}`);
    writeLog(logStream, `[${startedAt}] $ ${omxCommand} ${args.join(' ')}\n`);

    return new Promise((resolveResult, rejectResult) => {
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk);
        stdout.push(text);
        this.output.append(text);
        writeLog(logStream, text);
        callbacks.onOutput?.('stdout', text);
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        stderr.push(text);
        this.output.append(text);
        writeLog(logStream, text);
        callbacks.onOutput?.('stderr', text);
      });
      child.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        writeLog(logStream, `\n[${new Date().toISOString()}] launch error: ${err.message}\n`);
        logStream.end();
        callbacks.onError?.(err);
        rejectResult(err);
      });
      child.on('exit', (code, signal) => {
        writeLog(logStream, `\n[${new Date().toISOString()}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
        logStream.end();
        callbacks.onExit?.(code, signal);
        resolveResult({
          session_id: runId,
          command: omxCommand,
          args,
          pid: child.pid,
          log_path: logPath,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
          code,
          signal,
        });
      });
    });
  }

  async promptAndStart(mode: 'launch' | 'resume'): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      title: mode === 'resume' ? 'Resume OMX Session' : 'Start OMX Session',
      prompt: 'Task prompt to pass to Codex. Leave blank to open an interactive session.',
      ignoreFocusOut: true,
    });
    if (prompt === undefined) return;
    await this.start(mode, prompt.trim() || undefined);
  }

  stop(): void {
    if (!this.activeSession) {
      void vscode.window.showInformationMessage('No active OMX direct session.');
      return;
    }
    const sessionId = this.activeSession.session_id;
    const stopped = this.activeSession.stop();
    this.output.appendLine(`[omx] stop requested for ${sessionId}: ${stopped ? 'sent' : 'not sent'}`);
    this.activeSession = null;
    this.onDidChange();
  }

  async doctor(): Promise<void> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const omxCommand = resolveOmxCommand(cwd);
    const launchEnv = resolveOmxLaunchEnv(core, cwd, omxCommand);
    this.output.show(true);
    this.output.appendLine(`[omx] $ ${omxCommand} doctor`);
    if (launchEnv.codexPath) {
      this.output.appendLine(`[omx] codex: ${launchEnv.codexPath}`);
    }
    const child = spawn(omxCommand, ['doctor'], {
      cwd,
      env: { ...launchEnv.env, OMX_LAUNCH_POLICY: 'direct', OMX_VSCODE_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => this.output.append(String(chunk)));
    child.stderr?.on('data', (chunk) => this.output.append(String(chunk)));
    child.on('error', (error) => {
      this.output.appendLine(`[omx] doctor failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on('exit', (code, signal) => {
      this.output.appendLine(`[omx] doctor exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
  }
}

export function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a workspace folder before using OMX.');
  return folder.uri.fsPath;
}

function resolveOmxCommand(cwd: string): string {
  const configured = configuredOmxCommand();
  if (configured) return configured;

  const workspaceBin = path.join(cwd, 'dist', 'cli', 'omx.js');
  if (existsSync(workspaceBin)) return workspaceBin;

  return 'omx';
}

function vscodeLogPath(cwd: string, sessionId: string): string {
  return path.join(cwd, '.omx', 'logs', 'vscode', `${sessionId}.log`);
}

function openLogStream(logPath: string): WriteStream {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return createWriteStream(logPath, { flags: 'a' });
}

function writeLog(stream: WriteStream, text: string): void {
  stream.write(text);
}

function resolveOmxLaunchEnv(core: OmxCore, cwd: string, omxCommand: string): ReturnType<OmxCore['resolveVscodeLaunchEnv']> {
  return core.resolveVscodeLaunchEnv({
    cwd,
    omxCommand,
    extraPath: vscode.workspace.getConfiguration('omx').get<string[]>('extraPath') ?? [],
  });
}

function configuredOmxCommand(): string | null {
  const inspected = vscode.workspace.getConfiguration('omx').inspect<string>('command');
  const configuredValues = [
    inspected?.workspaceFolderValue,
    inspected?.workspaceValue,
    inspected?.globalValue,
  ];

  for (const value of configuredValues) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }

  return null;
}

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { loadOmxCore } from './core';
import { uiStrings } from './i18n';
import { getWorkspaceRoot, OmxSessionManager, type OmxCommandResult } from './sessionManager';
import {
  appendMessage,
  createConversation,
  listConversations,
  readConversation,
  updateMessage,
  type ChatConversation,
} from './chatStore';
import { listOmxHistory, type OmxHistorySnapshot, type OmxSessionHistoryItem } from './historyStore';
import type { WorkspaceSnapshot } from './types';

interface ChatWebviewState {
  conversation: ChatConversation | null;
  conversations: Awaited<ReturnType<typeof listConversations>>;
  snapshot: WorkspaceSnapshot | null;
  omxHistory: OmxHistorySnapshot;
  activeSession: {
    session_id: string;
    pid?: number;
    log_path: string;
    started_at: string;
  } | null;
}

export class OmxChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private activeConversationId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: OmxSessionManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderChatHtml(webviewView.webview);
    const disposables: vscode.Disposable[] = [];
    webviewView.onDidDispose(() => {
      for (const disposable of disposables) disposable.dispose();
      this.view = null;
    }, null, this.context.subscriptions);
    this.bindWebview(webviewView.webview, disposables);
    void this.refresh();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.omx');
    try {
      await vscode.commands.executeCommand('omx.chat.focus');
    } catch {
      await vscode.commands.executeCommand('workbench.view.extension.omx');
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const webviews = [this.view?.webview].filter((webview): webview is vscode.Webview => Boolean(webview));
    if (webviews.length === 0) return;
    try {
      const state = await this.buildState();
      await Promise.all(webviews.map((webview) => webview.postMessage({ type: 'state', state })));
    } catch (error) {
      await Promise.all(webviews.map((webview) => webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })));
    }
  }

  private bindWebview(webview: vscode.Webview, disposables: vscode.Disposable[]): void {
    webview.onDidReceiveMessage(async (message: {
      command?: string;
      text?: string;
      conversationId?: string;
      logPath?: string;
      quickCommand?: string;
      teamName?: string;
      sessionId?: string;
    }) => {
      switch (message.command) {
        case 'send':
          await this.send(message.text ?? '');
          break;
        case 'quickCommand':
          await this.runQuickCommand(message.quickCommand, message.text, message.teamName);
          break;
        case 'newConversation':
          await this.newConversation();
          break;
        case 'selectConversation':
          await this.selectConversation(message.conversationId);
          break;
        case 'selectOmxSession':
          await this.selectOmxSession(message.sessionId);
          break;
        case 'openLog':
          await this.openLog(message.logPath);
          break;
        case 'stop':
          this.sessionManager.stop();
          await this.refresh();
          break;
        case 'doctor':
          await this.sessionManager.doctor();
          break;
        case 'openDashboard':
          await vscode.commands.executeCommand('omx.openDashboard');
          break;
        case 'openControlCenter':
          await vscode.commands.executeCommand('omx.openControlCenter');
          break;
        case 'openLogExplorer':
          await vscode.commands.executeCommand('omx.openLogExplorer');
          break;
        case 'refresh':
          await this.refresh();
          break;
      }
    }, null, disposables);
  }

  private async buildState(): Promise<ChatWebviewState> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const snapshot = await core.readWorkspaceSnapshot({ cwd, maxLogs: 12 });
    const [conversations, omxHistory] = await Promise.all([
      listConversations(cwd),
      listOmxHistory(cwd, 24),
    ]);
    if (!this.activeConversationId && conversations[0]) {
      this.activeConversationId = conversations[0].id;
    }
    const conversation = this.activeConversationId
      ? await readConversation(cwd, this.activeConversationId)
      : null;
    return {
      conversation,
      conversations,
      snapshot,
      omxHistory,
      activeSession: this.sessionManager.active
        ? {
          session_id: this.sessionManager.active.session_id,
          pid: this.sessionManager.active.pid,
          log_path: this.sessionManager.active.log_path,
          started_at: this.sessionManager.active.started_at,
        }
        : null,
    };
  }

  private async ensureConversation(initialText?: string): Promise<ChatConversation> {
    const cwd = getWorkspaceRoot();
    if (this.activeConversationId) {
      const existing = await readConversation(cwd, this.activeConversationId);
      if (existing) return existing;
    }
    const created = await createConversation(cwd, initialText);
    this.activeConversationId = created.id;
    return created;
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    const cwd = getWorkspaceRoot();
    const conversation = await this.ensureConversation(text);
    await appendMessage(cwd, conversation.id, { role: 'user', text });
    await this.refresh();

    let progress: WorkProgressRecorder | null = null;
    try {
      const activeSession = this.sessionManager.active;
      if (activeSession?.session_id.startsWith('vscode-exec-')) {
        const omxSessionId = await this.sessionManager.currentOmxSessionId();
        if (omxSessionId) {
          progress = new WorkProgressRecorder(cwd, conversation.id, () => this.refresh(), {
            title: '후속 요청 주입',
            initialSummary: [
              `활성 OMX 세션 ${omxSessionId}에 후속 요청을 전달합니다.`,
              summarizePrompt(text),
            ],
          });
          await progress.start();
          const result = await this.sessionManager.injectExecFollowup(omxSessionId, text, {
            onOutput: (stream, chunk) => progress?.noteOutput(stream, chunk),
            onError: (error) => progress?.noteError(error),
          });
          await progress.setRunInfo({
            sessionId: omxSessionId,
            logPath: result.log_path,
            summary: [`주입 명령 완료: code=${result.code ?? 'null'}`],
          });
          await progress.finish({ code: result.code, signal: result.signal });
          await this.refresh();
          return;
        }

        await appendMessage(cwd, conversation.id, {
          role: 'system',
          text: 'Active exec session exists, but OMX session state was not available for inject. Starting a new exec turn instead.',
        });
      }

      let errorMessage: string | null = null;
      const execPrompt = buildExecPrompt(conversation, text);
      progress = new WorkProgressRecorder(cwd, conversation.id, () => this.refresh(), {
        title: 'OMX 작업',
        initialSummary: [
          '요청을 받아 OMX exec 세션을 시작합니다.',
          summarizePrompt(text),
        ],
        commandLine: 'omx exec <chat prompt>',
      });
      await progress.start();
      let execHandle: Awaited<ReturnType<OmxSessionManager['exec']>> | null = null;
      execHandle = await this.sessionManager.exec(execPrompt, {
        onOutput: (stream, chunk) => {
          progress?.noteOutput(stream, chunk);
        },
        onError: (error) => {
          errorMessage = error.message;
          progress?.noteError(error);
        },
        onExit: (code, signal) => {
          void progress?.finish({ code, signal, errorMessage });
        },
      });
      await progress.setRunInfo({
        sessionId: execHandle.session_id,
        logPath: execHandle.log_path,
        summary: [`세션 ${execHandle.session_id} 시작`, '상세 출력은 접힌 상태로 계속 갱신됩니다.'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[omx] chat launch failed: ${message}`);
      if (progress) {
        await progress.failBeforeLaunch(error instanceof Error ? error : new Error(message));
      } else {
        await appendMessage(cwd, conversation.id, {
          role: 'assistant',
          text: `Launch failed:\n${message}`,
        });
      }
    }
    await this.refresh();
  }

  private async runQuickCommand(commandId: string | undefined, rawText?: string, teamName?: string): Promise<void> {
    if (!commandId) return;
    const prompt = rawText?.trim() || undefined;
    const cwd = getWorkspaceRoot();
    const conversation = await this.ensureConversation(`OMX ${commandId}`);

    if (commandId === 'launch' || commandId === 'resume') {
      const progress = new WorkProgressRecorder(cwd, conversation.id, () => this.refresh(), {
        title: `OMX ${commandId}`,
        initialSummary: [
          `OMX ${commandId} 세션을 시작합니다.`,
          ...(prompt ? [summarizePrompt(prompt)] : ['프롬프트 없이 대화형 세션을 시작합니다.']),
        ],
        commandLine: `omx ${commandId}`,
      });
      await progress.start();
      let errorMessage: string | null = null;
      let launchedHandle: Awaited<ReturnType<OmxSessionManager['start']>> = null;
      try {
        launchedHandle = await this.sessionManager.start(commandId === 'resume' ? 'resume' : 'launch', prompt, {
          onOutput: (stream, chunk) => {
            progress.noteOutput(stream, chunk);
          },
          onError: (error) => {
            errorMessage = error.message;
            progress.noteError(error);
          },
          onExit: (code, signal) => {
            void progress.finish({ code, signal, errorMessage });
          },
        });
        if (launchedHandle) {
          await progress.setRunInfo({
            sessionId: launchedHandle.session_id,
            logPath: launchedHandle.log_path,
            summary: [`세션 ${launchedHandle.session_id} 시작`, '상세 출력은 접힌 상태로 계속 갱신됩니다.'],
          });
        } else {
          await progress.finish({ status: 'cancelled', code: null, signal: null });
        }
      } catch (error) {
        await progress.failBeforeLaunch(error instanceof Error ? error : new Error(String(error)));
      } finally {
        await this.refresh();
      }
      return;
    }

    if (commandId === 'teamStatus') {
      const selectedTeam = await this.resolveTeamName(teamName);
      if (!selectedTeam) {
        await appendMessage(cwd, conversation.id, {
          role: 'system',
          text: 'No OMX team state was found in this workspace.',
        });
        await this.refresh();
        return;
      }
      try {
        const core = await loadOmxCore(this.context);
        const status = await core.readTeamSnapshot({ cwd, teamName: selectedTeam, refreshMonitor: true });
        await appendMessage(cwd, conversation.id, {
          role: 'system',
          text: formatWorkMessage({
            title: `✅ OMX team status: ${selectedTeam}`,
            summary: [
              `팀 ${selectedTeam} 상태를 불러왔습니다.`,
              `workers: ${Array.isArray((status as { workers?: unknown }).workers) ? (status as { workers: unknown[] }).workers.length : 'unknown'}`,
              `tasks: ${Array.isArray((status as { tasks?: unknown }).tasks) ? (status as { tasks: unknown[] }).tasks.length : 'unknown'}`,
            ],
            details: truncateOutput(JSON.stringify(status, null, 2)),
          }),
        });
      } catch (error) {
        await appendMessage(cwd, conversation.id, {
          role: 'assistant',
          text: `Team status failed:\n${error instanceof Error ? error.message : String(error)}`,
        });
      }
      await this.refresh();
      return;
    }

    if (commandId === 'teamShutdown') {
      const selectedTeam = await this.resolveTeamName(teamName);
      if (!selectedTeam) {
        await appendMessage(cwd, conversation.id, {
          role: 'system',
          text: 'No OMX team state was found in this workspace.',
        });
        await this.refresh();
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Shutdown OMX team "${selectedTeam}"?`,
        { modal: true },
        'Shutdown',
      );
      if (choice !== 'Shutdown') return;
      await this.runAndRecordCommand(conversation.id, ['team', 'shutdown', selectedTeam], `team-shutdown-${selectedTeam}`);
      return;
    }

    const commandArgs = quickCommandArgs(commandId);
    if (!commandArgs) return;
    await this.runAndRecordCommand(conversation.id, commandArgs, `command-${commandId}`);
  }

  private async runAndRecordCommand(conversationId: string, args: string[], runIdPrefix: string): Promise<void> {
    const cwd = getWorkspaceRoot();
    const progress = new WorkProgressRecorder(cwd, conversationId, () => this.refresh(), {
      title: `OMX 명령`,
      initialSummary: [`omx ${args.join(' ')} 명령을 실행합니다.`],
      commandLine: `omx ${args.join(' ')}`,
    });
    await progress.start();

    try {
      const result = await this.sessionManager.runCommand(args, runIdPrefix, {
        onOutput: (stream, chunk) => progress.noteOutput(stream, chunk),
        onError: (error) => progress.noteError(error),
      });
      await progress.setRunInfo({
        sessionId: result.session_id,
        logPath: result.log_path,
        summary: [`명령 종료: code=${result.code ?? 'null'}`],
      });
      await progress.finish({ code: result.code, signal: result.signal });
    } catch (error) {
      await progress.failBeforeLaunch(error instanceof Error ? error : new Error(String(error)));
    }
    await this.refresh();
  }

  private async resolveTeamName(teamName: string | undefined): Promise<string | null> {
    if (teamName?.trim()) return teamName.trim();
    try {
      const core = await loadOmxCore(this.context);
      const snapshot = await core.readWorkspaceSnapshot({ cwd: getWorkspaceRoot(), maxLogs: 1 });
      return snapshot.teams[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  private async newConversation(): Promise<void> {
    const created = await createConversation(getWorkspaceRoot());
    this.activeConversationId = created.id;
    await this.refresh();
  }

  private async selectConversation(id: string | undefined): Promise<void> {
    if (!id) return;
    this.activeConversationId = id;
    await this.refresh();
  }

  private async selectOmxSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const cwd = getWorkspaceRoot();
    const state = await this.buildState();
    const session = state.omxHistory.sessions.find((item) => item.session_id === sessionId);
    if (!session) return;
    const conversation = await this.ensureConversation(`OMX session ${sessionId}`);
    await appendMessage(cwd, conversation.id, {
      role: 'system',
      text: formatSessionHistory(session),
      session_id: session.session_id,
      log_path: session.log_path,
    });
    await this.refresh();
  }

  private async openLog(logPath: string | undefined): Promise<void> {
    if (!logPath) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

type WorkProgressStatus = 'running' | 'success' | 'failed' | 'cancelled';

interface WorkProgressRecorderOptions {
  title: string;
  initialSummary?: string[];
  role?: 'assistant' | 'system';
  commandLine?: string;
}

interface WorkProgressFinishOptions {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string | null;
  status?: WorkProgressStatus;
}

class WorkProgressRecorder {
  readonly messageId = `work-${Date.now()}-${randomUUID().slice(0, 8)}`;
  private readonly outputChunks: string[] = [];
  private readonly summaryHints: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private status: WorkProgressStatus = 'running';
  private sessionId: string | undefined;
  private logPath: string | undefined;
  private exitLine: string | undefined;
  private errorMessage: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly conversationId: string,
    private readonly refresh: () => Promise<void>,
    private readonly options: WorkProgressRecorderOptions,
  ) {
    this.summaryHints.push(...(options.initialSummary ?? []));
    if (options.commandLine) this.summaryHints.push(`실행: ${options.commandLine}`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await appendMessage(this.cwd, this.conversationId, {
      id: this.messageId,
      role: this.options.role ?? 'assistant',
      text: this.renderText(),
    });
    await this.refresh();
  }

  async setRunInfo(info: { sessionId?: string; logPath?: string; summary?: string[] }): Promise<void> {
    if (info.sessionId) this.sessionId = info.sessionId;
    if (info.logPath) this.logPath = info.logPath;
    if (info.summary) this.summaryHints.push(...info.summary);
    await this.flushNow();
  }

  noteOutput(stream: 'stdout' | 'stderr', chunk: string): void {
    const normalized = normalizeStreamChunk(stream, chunk);
    if (normalized.trim()) {
      this.outputChunks.push(normalized);
    }
    this.scheduleFlush();
  }

  noteError(error: Error): void {
    this.errorMessage = error.message;
    this.summaryHints.push(`오류: ${error.message}`);
    this.scheduleFlush();
  }

  async finish(options: WorkProgressFinishOptions = {}): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.status = options.status ?? (options.code === 0 ? 'success' : 'failed');
    this.exitLine = `Exit: code=${options.code ?? 'null'} signal=${options.signal ?? 'null'}`;
    if (options.errorMessage) this.errorMessage = options.errorMessage;
    if (this.status === 'success') this.summaryHints.push('작업이 완료되었습니다.');
    if (this.status === 'failed') this.summaryHints.push('작업이 실패했거나 중단되었습니다.');
    if (this.status === 'cancelled') this.summaryHints.push('사용자 확인 또는 실행 전 단계에서 취소되었습니다.');
    await this.flushNow();
  }

  async failBeforeLaunch(error: Error): Promise<void> {
    this.status = 'failed';
    this.errorMessage = error.message;
    this.summaryHints.push(`실행 시작 실패: ${error.message}`);
    await this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, 750);
  }

  private async flushNow(): Promise<void> {
    if (!this.started) return;
    const text = this.renderText();
    this.writeQueue = this.writeQueue
      .then(async () => {
        await updateMessage(this.cwd, this.conversationId, this.messageId, {
          role: this.options.role ?? 'assistant',
          text,
          session_id: this.sessionId,
          log_path: this.logPath,
        });
        await this.refresh();
      })
      .catch(async (error) => {
        this.errorMessage = error instanceof Error ? error.message : String(error);
      });
    await this.writeQueue;
  }

  private renderText(): string {
    const title = `${statusIcon(this.status)} ${this.options.title}${this.status === 'running' ? ' 진행 중' : ''}`;
    const output = this.outputChunks.join('').trim();
    const summary = uniqueSummaryLines([
      ...this.summaryHints,
      ...extractKeyOutputLines(output, 5),
      ...(this.sessionId ? [`세션: ${this.sessionId}`] : []),
      ...(this.exitLine ? [this.exitLine] : []),
      ...(this.errorMessage ? [`오류: ${this.errorMessage}`] : []),
      ...(this.logPath ? ['상세 로그가 연결되었습니다.'] : []),
    ], 8);
    const detailParts = [
      this.options.commandLine ? `Command: ${this.options.commandLine}` : '',
      this.sessionId ? `Session: ${this.sessionId}` : '',
      this.logPath ? `Log: ${this.logPath}` : '',
      output || '(아직 출력 없음)',
      this.exitLine ?? '',
      this.errorMessage ? `Error: ${this.errorMessage}` : '',
    ].filter(Boolean);
    return formatWorkMessage({
      title,
      summary,
      details: truncateOutput(detailParts.join('\n\n')),
    });
  }
}

function buildExecPrompt(conversation: ChatConversation, currentText: string): string {
  const history = conversation.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role.toUpperCase()}:\n${message.text.trim()}`)
    .join('\n\n');

  if (!history.trim()) return currentText;

  const prompt = [
    'You are continuing an OMX VSCode chat conversation in this workspace.',
    'Use the prior conversation only as context. Act on the current user request.',
    '',
    'Prior conversation:',
    history,
    '',
    'Current user request:',
    currentText,
  ].join('\n');

  return prompt.length > 20_000
    ? `${prompt.slice(0, 19_500)}\n\n[Conversation context truncated]\n\nCurrent user request:\n${currentText}`
    : prompt;
}

function quickCommandArgs(commandId: string): string[] | null {
  switch (commandId) {
    case 'doctor':
      return ['doctor'];
    case 'doctorTeam':
      return ['doctor', '--team'];
    case 'list':
      return ['list'];
    case 'hud':
      return ['hud', '--json'];
    case 'cleanup':
      return ['cleanup'];
    default:
      return null;
  }
}

function formatCommandResult(result: OmxCommandResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return [
    `Command: omx ${result.args.join(' ')}`,
    stdout ? `\n${truncateOutput(stdout)}` : '\n(no stdout)',
    stderr ? `\nStderr:\n${truncateOutput(stderr)}` : '',
    '',
    `Exit: code=${result.code ?? 'null'} signal=${result.signal ?? 'null'}`,
    `Log: ${result.log_path}`,
  ].filter(Boolean).join('\n');
}

function formatSessionHistory(session: OmxSessionHistoryItem): string {
  return [
    `OMX session: ${session.session_id}`,
    `Started: ${session.started_at}`,
    ...(session.ended_at ? [`Ended: ${session.ended_at}`] : []),
    ...(session.pid ? [`PID: ${session.pid}`] : []),
    ...(session.cwd ? [`Workspace: ${session.cwd}`] : []),
    ...(session.log_path ? [`Log: ${session.log_path}`] : []),
    `History source: ${session.source_path}`,
  ].join('\n');
}

function formatWorkMessage(options: { title: string; summary: string[]; details: string }): string {
  const summary = options.summary.length
    ? options.summary.map((line) => line.trim()).filter(Boolean).map((line) => line.startsWith('•') ? line : `• ${line}`).join('\n')
    : '• 핵심 진행 내용을 기다리는 중입니다.';
  return [
    options.title,
    '',
    '핵심:',
    summary,
    '',
    '상세:',
    options.details.trim() || '(상세 출력 없음)',
  ].join('\n');
}

function summarizePrompt(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim() || '빈 요청';
  return `요청: ${firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine}`;
}

function statusIcon(status: WorkProgressStatus): string {
  switch (status) {
    case 'success':
      return '✅';
    case 'failed':
      return '⚠️';
    case 'cancelled':
      return '⏹';
    case 'running':
    default:
      return '⏳';
  }
}

function normalizeStreamChunk(stream: 'stdout' | 'stderr', chunk: string): string {
  if (stream === 'stdout') return chunk;
  const normalized = chunk.replace(/\r\n/g, '\n');
  return normalized
    .split('\n')
    .map((line, index, lines) => {
      if (!line && index === lines.length - 1) return line;
      return line ? `[stderr] ${line}` : '[stderr]';
    })
    .join('\n');
}

function extractKeyOutputLines(output: string, maxLines: number): string[] {
  const lines = stripAnsi(output)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNoisyProgressLine(line));
  const preferred = lines.filter((line) => isKeyProgressLine(line));
  const source = preferred.length ? preferred : lines;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...source].reverse()) {
    const line = compactProgressLine(raw);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    result.unshift(line);
    if (result.length >= maxLines) break;
  }
  return result;
}

function isKeyProgressLine(line: string): boolean {
  return (
    /^[→•✓✔✗✖-]\s+/.test(line) ||
    /\b(succeeded|failed|error|warning|modified|created|deleted|renamed|updated|compiled|built|installed|launched)\b/i.test(line) ||
    /\b(exec|apply_patch|npm|node|tsc|vsce|code --install-extension|omx)\b/.test(line) ||
    /^Exit: /.test(line) ||
    /^Log: /.test(line)
  );
}

function isNoisyProgressLine(line: string): boolean {
  return (
    line === '--------' ||
    /^(OpenAI Codex|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|user$)/i.test(line) ||
    /^Original token count: /.test(line) ||
    /^Chunk ID: /.test(line) ||
    /^Wall time: /.test(line) ||
    /^Process exited with code /.test(line) ||
    /^Reading additional input from stdin/.test(line.replace(/^\[stderr\]\s*/, ''))
  );
}

function compactProgressLine(line: string): string {
  const withoutPrefix = line.replace(/^\[stderr\]\s*/, '').replace(/\s+/g, ' ').trim();
  return withoutPrefix.length > 150 ? `${withoutPrefix.slice(0, 147)}...` : withoutPrefix;
}

function uniqueSummaryLines(lines: string[], maxLines: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
    if (result.length >= maxLines) break;
  }
  return result;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function truncateOutput(value: string, maxLength = 18_000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[Output truncated. Open the log for the full command output.]`;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function renderChatHtml(webview: vscode.Webview): string {
  const scriptNonce = nonce();
  const strings = uiStrings();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${scriptNonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${strings.chatTitle}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      height: 100vh;
      overflow: hidden;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 5px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:hover {
      border-color: var(--vscode-focusBorder);
    }
    .chat-shell {
      position: relative;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      height: 100vh;
      min-height: 280px;
      background: var(--vscode-editor-background);
    }
    .chat-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .title-wrap {
      flex: 1;
      min-width: 0;
    }
    .chat-title {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-subtitle {
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .top-button {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .messages {
      min-height: 0;
      overflow: auto;
      padding: 10px 10px 12px;
      scroll-behavior: smooth;
    }
    .runtime-summary {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
    }
    .status-card {
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      background: var(--vscode-sideBar-background);
    }
    .status-card-title {
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .status-card-main,
    .status-card-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-card-main {
      font-weight: 600;
    }
    .milestone-list {
      display: grid;
      gap: 6px;
    }
    .milestone {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 5px 0;
    }
    .milestone-dot {
      width: 8px;
      height: 8px;
      margin-top: 4px;
      border-radius: 999px;
      background: var(--vscode-descriptionForeground);
    }
    .milestone.done .milestone-dot {
      background: var(--vscode-testing-iconPassed);
    }
    .milestone.active .milestone-dot {
      background: var(--vscode-testing-iconQueued);
    }
    .milestone-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .status-card-meta,
    .meta,
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .team-row,
    .subagent-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 5px 0;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .team-row:first-child,
    .subagent-row:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .mini-actions {
      display: flex;
      gap: 5px;
      justify-content: flex-end;
    }
    .mini-actions button {
      padding: 3px 6px;
      font-size: 11px;
    }
    .message {
      margin: 0 0 13px;
      max-width: 920px;
    }
    .message.user {
      margin-left: auto;
      max-width: min(760px, 92%);
    }
    .message.user .role {
      text-align: right;
    }
    .role {
      margin-bottom: 3px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .bubble {
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      padding: 9px 10px;
      line-height: 1.45;
    }
    .message.user .bubble {
      background: var(--vscode-inputOption-activeBackground);
      border-color: var(--vscode-focusBorder);
    }
    .message.system .bubble {
      color: var(--vscode-descriptionForeground);
      background: transparent;
    }
    .work-card {
      display: grid;
      gap: 8px;
      white-space: normal;
    }
    .work-card-header {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
    }
    .work-spinner {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--vscode-descriptionForeground);
    }
    .work-spinner.running {
      background: var(--vscode-testing-iconQueued);
      animation: omxPulse 1.15s ease-in-out infinite;
    }
    .work-spinner.success {
      background: var(--vscode-testing-iconPassed);
    }
    .work-spinner.failed {
      background: var(--vscode-testing-iconFailed);
    }
    .work-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-weight: 700;
    }
    .work-summary {
      white-space: pre-wrap;
      color: var(--vscode-foreground);
      line-height: 1.45;
    }
    .work-details {
      margin-top: 1px;
    }
    @keyframes omxPulse {
      0%, 100% { opacity: 0.45; transform: scale(0.84); }
      50% { opacity: 1; transform: scale(1.08); }
    }
    .action-details {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }
    .action-details summary {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px 9px;
      cursor: pointer;
      list-style: none;
    }
    .action-details summary::-webkit-details-marker {
      display: none;
    }
    .action-details summary::before {
      content: '›';
      color: var(--vscode-descriptionForeground);
    }
    .action-details[open] summary::before {
      content: '⌄';
    }
    .action-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .action-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
    }
    .action-body {
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px solid var(--vscode-panel-border);
      padding: 9px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      max-height: 50vh;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    .message-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 5px;
    }
    .link-button {
      padding: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      border: 0;
      font-size: 11px;
    }
    .command-bar {
      display: grid;
      gap: 7px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .status-block {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--vscode-descriptionForeground);
    }
    .status-dot.busy {
      background: var(--vscode-testing-iconQueued);
    }
    .status-dot.ready {
      background: var(--vscode-testing-iconPassed);
    }
    .status-title,
    .status-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-meta {
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .action-row {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: wrap;
    }
    .action-button {
      padding: 4px 8px;
      font-size: 12px;
    }
    .composer-wrap {
      padding: 0 12px 12px;
      background: var(--vscode-editor-background);
    }
    .composer-card {
      display: grid;
      grid-template-rows: minmax(64px, auto) auto;
      gap: 8px;
      min-height: 124px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-input-background);
      padding: 10px 10px 8px;
    }
    .composer-card textarea {
      width: 100%;
      min-height: 62px;
      max-height: 180px;
      resize: none;
      color: var(--vscode-input-foreground);
      background: transparent;
      border: 0;
      outline: 0;
      padding: 0 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    .composer-card textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .composer-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .composer-tool {
      min-width: 28px;
      min-height: 28px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
    }
    .round-tool {
      width: 28px;
      padding: 0;
      font-size: 20px;
      line-height: 1;
    }
    .mode-chip {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      max-width: 42%;
      padding: 3px 8px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 999px;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .spacer {
      flex: 1;
      min-width: 4px;
    }
    .send-button {
      width: 32px;
      height: 32px;
      padding: 0;
      border-radius: 999px;
      font-size: 19px;
      line-height: 1;
    }
    .history-panel {
      position: absolute;
      top: 50px;
      left: 10px;
      right: 10px;
      z-index: 3;
      display: none;
      max-height: min(520px, 62vh);
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 12px 28px rgb(0 0 0 / 0.28);
      padding: 10px;
    }
    body.history-open .history-panel {
      display: grid;
    }
    .history-section {
      min-width: 0;
      overflow: auto;
    }
    .history-entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      align-items: start;
      margin: 0 0 6px;
    }
    .history-entry-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .history-entry-actions button {
      padding: 3px 6px;
      font-size: 11px;
    }
    .section-title {
      margin: 0 0 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .item {
      display: block;
      width: 100%;
      margin: 0;
      padding: 7px 8px;
      border-radius: 6px;
      text-align: left;
      color: var(--vscode-foreground);
      background: transparent;
      border: 1px solid transparent;
    }
    .item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .item .meta,
    .item-meta {
      display: block;
      margin-top: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .error {
      color: var(--vscode-errorForeground);
      padding: 12px;
    }
    @media (max-width: 620px) {
      .mode-chip { max-width: 34%; }
    }
  </style>
</head>
<body>
  <div class="chat-shell">
    <header class="chat-header">
      <div class="title-wrap">
        <div id="title" class="chat-title">OMX Chat</div>
        <div id="subtitle" class="chat-subtitle">OMX 상태를 불러오는 중</div>
      </div>
      <button id="historyToggle" class="top-button" title="Show work history and logs">History</button>
    </header>

    <section id="historyPanel" class="history-panel" aria-label="OMX history">
      <div class="history-section">
        <div class="section-title">Conversations</div>
        <div id="conversations"></div>
      </div>
      <div class="history-section">
        <div class="section-title">Work History</div>
        <div id="omxSessions"></div>
      </div>
      <div class="history-section">
        <div class="section-title">Event Logs</div>
        <div id="eventLogs"></div>
      </div>
      <div class="history-section">
        <div class="section-title">VSCode Logs</div>
        <div id="vscodeLogs"></div>
      </div>
    </section>

    <main id="scrollArea" class="messages">
      <section id="runtimeSummary" class="runtime-summary"></section>
      <section id="messageList"></section>
    </main>

    <section class="command-bar">
      <div class="status-block">
        <span id="statusDot" class="status-dot"></span>
        <div>
          <div id="statusText" class="status-title">OMX idle</div>
          <div id="statusMeta" class="status-meta">No active session</div>
        </div>
      </div>
      <div class="action-row">
        <button id="new" class="action-button secondary">New</button>
        <button class="action-button" data-quick="launch">${strings.startWork}</button>
        <button class="action-button secondary" data-quick="resume">${strings.resumeWork}</button>
        <button class="action-button secondary" data-quick="doctor">${strings.doctor}</button>
        <button class="action-button secondary" data-quick="doctorTeam">Team Doctor</button>
        <button class="action-button secondary" data-quick="teamStatus">Team Status</button>
        <button class="action-button secondary" data-quick="list">List</button>
        <button class="action-button secondary" data-quick="hud">HUD</button>
        <button id="controlCenter" class="action-button secondary">${strings.openControlCenter}</button>
        <button id="openLogs" class="action-button secondary">${strings.viewLogs}</button>
        <button id="dashboard" class="action-button secondary">Dashboard</button>
        <button id="stop" class="action-button secondary">${strings.stop}</button>
        <button id="refresh" class="action-button secondary" title="${strings.refresh}">${strings.refresh}</button>
      </div>
    </section>

    <section class="composer-wrap">
      <div class="composer-card">
        <textarea id="input" placeholder="OMX에 요청하거나 위 버튼으로 명령을 실행하세요" rows="3"></textarea>
        <div class="composer-tools">
          <button id="addContext" class="composer-tool round-tool" title="Show history and logs" aria-label="Show history and logs">+</button>
          <span class="mode-chip" title="Current execution surface">대화 입력</span>
          <div class="spacer"></div>
          <span id="modelChip" class="mode-chip" title="OMX runner">OMX</span>
          <span id="locationChip" class="mode-chip" title="Workspace execution">로컬에서 작업</span>
          <button id="send" class="send-button" title="Send" aria-label="Send">↑</button>
        </div>
      </div>
    </section>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const conversationsEl = document.getElementById('conversations');
    const omxSessionsEl = document.getElementById('omxSessions');
    const eventLogsEl = document.getElementById('eventLogs');
    const vscodeLogsEl = document.getElementById('vscodeLogs');
    const scrollAreaEl = document.getElementById('scrollArea');
    const runtimeSummaryEl = document.getElementById('runtimeSummary');
    const messageListEl = document.getElementById('messageList');
    const titleEl = document.getElementById('title');
    const subtitleEl = document.getElementById('subtitle');
    const statusDotEl = document.getElementById('statusDot');
    const statusTextEl = document.getElementById('statusText');
    const statusMetaEl = document.getElementById('statusMeta');
    const inputEl = document.getElementById('input');
    let historyOpen = false;
    let stickToBottom = true;
    let forceNextScrollToBottom = true;
    let hasRenderedMessages = false;
    const expandedActionKeys = new Set();
    const actionBodyScrollPositions = new Map();

    scrollAreaEl.addEventListener('scroll', () => {
      stickToBottom = isNearBottom();
    });

    function post(command, extra = {}) {
      vscode.postMessage({ command, ...extra });
    }

    function quick(command, teamName) {
      requestBottomScroll();
      post('quickCommand', { quickCommand: command, text: inputEl.value.trim(), teamName });
    }

    document.getElementById('new').addEventListener('click', () => {
      requestBottomScroll();
      post('newConversation');
    });
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('dashboard').addEventListener('click', () => post('openDashboard'));
    document.getElementById('controlCenter').addEventListener('click', () => post('openControlCenter'));
    document.getElementById('openLogs').addEventListener('click', () => post('openLogExplorer'));
    document.getElementById('stop').addEventListener('click', () => post('stop'));
    document.getElementById('send').addEventListener('click', send);
    document.getElementById('historyToggle').addEventListener('click', toggleHistory);
    document.getElementById('addContext').addEventListener('click', toggleHistory);
    document.querySelectorAll('[data-quick]').forEach((button) => {
      button.addEventListener('click', () => quick(button.getAttribute('data-quick')));
    });
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
    });

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      requestBottomScroll();
      post('send', { text });
    }

    function toggleHistory() {
      historyOpen = !historyOpen;
      document.body.classList.toggle('history-open', historyOpen);
    }

    function formatTime(value) {
      if (!value) return '';
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }

    function renderState(state) {
      const shouldScrollAfterRender = forceNextScrollToBottom || !hasRenderedMessages || stickToBottom || isNearBottom();
      const conversation = state.conversation;
      titleEl.textContent = conversation ? conversation.title : 'OMX Chat';
      renderStatus(state);
      renderRuntimeSummary(state);
      renderConversations(state.conversations || [], conversation && conversation.id);
      renderOmxSessions((state.omxHistory && state.omxHistory.sessions) || []);
      renderEventLogs((state.omxHistory && state.omxHistory.eventLogs) || []);
      renderLogs((state.snapshot && state.snapshot.logs) || []);
      const messages = conversation ? conversation.messages : [];
      pruneExpandedActionKeys(messages);
      renderMessages(messages, state.activeSession, shouldScrollAfterRender);
      forceNextScrollToBottom = false;
      hasRenderedMessages = true;
    }

    function renderStatus(state) {
      const snapshot = state.snapshot || {};
      const active = state.activeSession;
      const hud = (snapshot.hud_text || '').trim();
      const currentSessionId = snapshot.current_session_id || '';
      if (active) {
        statusDotEl.className = 'status-dot busy';
        statusTextEl.textContent = 'OMX 실행 중';
        statusMetaEl.textContent = active.session_id + (active.pid ? ' · pid ' + active.pid : '') + (hud ? ' · ' + hud : '');
        subtitleEl.textContent = active.log_path || active.session_id;
        return;
      }
      if (currentSessionId) {
        statusDotEl.className = 'status-dot ready';
        statusTextEl.textContent = 'OMX 세션 감지됨';
        statusMetaEl.textContent = currentSessionId + (hud ? ' · ' + hud : '');
        subtitleEl.textContent = currentSessionId;
        return;
      }
      statusDotEl.className = 'status-dot';
      statusTextEl.textContent = hud || 'OMX idle';
      statusMetaEl.textContent = snapshot.cwd || 'No active session';
      subtitleEl.textContent = hud || 'No active session';
    }

    function renderRuntimeSummary(state) {
      runtimeSummaryEl.textContent = '';
      const snapshot = state.snapshot || {};
      const hud = snapshot.hud || {};
      const statusGrid = document.createElement('div');
      statusGrid.className = 'status-grid';
      statusGrid.appendChild(statusCard('Runtime', state.activeSession ? 'Running' : (snapshot.current_session_id ? 'Session detected' : 'Idle'), snapshot.current_session_id || (state.activeSession && state.activeSession.session_id) || snapshot.cwd || 'No workspace state'));
      statusGrid.appendChild(statusCard('HUD', (snapshot.hud_text || 'OMX idle').trim(), snapshot.generated_at ? 'Updated ' + formatTime(snapshot.generated_at) : ''));
      statusGrid.appendChild(statusCard('Metrics', metricSummary(hud.metrics), metricMeta(hud.metrics)));

      const activeModes = extractActiveModes(hud);
      statusGrid.appendChild(statusCard('Modes', activeModes.length ? activeModes.join(', ') : 'None active', activeModes.length ? 'Mode state from .omx/state' : 'No active workflow mode'));
      runtimeSummaryEl.appendChild(statusGrid);
      runtimeSummaryEl.appendChild(renderMilestones(state));

      const teams = (snapshot.teams || []);
      if (teams.length) {
        const card = sectionCard('Teams');
        for (const team of teams) {
          const row = document.createElement('div');
          row.className = 'team-row';
          const info = document.createElement('div');
          info.className = 'status-card-main';
          info.textContent = team.name;
          const meta = document.createElement('div');
          meta.className = 'status-card-meta';
          meta.textContent = formatTime(team.updated_at);
          const wrap = document.createElement('div');
          wrap.appendChild(info);
          wrap.appendChild(meta);
          const actions = document.createElement('div');
          actions.className = 'mini-actions';
          const statusButton = document.createElement('button');
          statusButton.className = 'secondary';
          statusButton.textContent = 'Status';
          statusButton.addEventListener('click', () => quick('teamStatus', team.name));
          const shutdownButton = document.createElement('button');
          shutdownButton.className = 'secondary';
          shutdownButton.textContent = 'Shutdown';
          shutdownButton.addEventListener('click', () => quick('teamShutdown', team.name));
          actions.appendChild(statusButton);
          actions.appendChild(shutdownButton);
          row.appendChild(wrap);
          row.appendChild(actions);
          card.appendChild(row);
        }
        runtimeSummaryEl.appendChild(card);
      }

      const subagents = (state.omxHistory && state.omxHistory.subagents) || [];
      if (subagents.length) {
        const card = sectionCard('Subagents');
        for (const session of subagents.slice(0, 4)) {
          const row = document.createElement('div');
          row.className = 'subagent-row';
          const main = document.createElement('div');
          main.className = 'status-card-main';
          main.textContent = session.session_id;
          const meta = document.createElement('div');
          meta.className = 'status-card-meta';
          meta.textContent = session.active_subagents + ' active · ' + session.completed_subagents + ' completed · ' + formatTime(session.updated_at);
          const wrap = document.createElement('div');
          wrap.appendChild(main);
          wrap.appendChild(meta);
          row.appendChild(wrap);
          card.appendChild(row);
        }
        runtimeSummaryEl.appendChild(card);
      }
    }

    function sectionCard(title) {
      const card = document.createElement('div');
      card.className = 'status-card';
      const label = document.createElement('div');
      label.className = 'status-card-title';
      label.textContent = title;
      card.appendChild(label);
      return card;
    }

    function statusCard(title, mainText, metaText) {
      const card = sectionCard(title);
      const main = document.createElement('div');
      main.className = 'status-card-main';
      main.textContent = mainText || 'Unknown';
      const meta = document.createElement('div');
      meta.className = 'status-card-meta';
      meta.textContent = metaText || '';
      card.appendChild(main);
      card.appendChild(meta);
      return card;
    }

    function renderMilestones(state) {
      const card = sectionCard('${strings.milestones}');
      const list = document.createElement('div');
      list.className = 'milestone-list';
      const snapshot = state.snapshot || {};
      const history = (state.omxHistory && state.omxHistory.sessions) || [];
      const messages = state.conversation ? state.conversation.messages || [] : [];
      const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant' || message.role === 'system');
      const milestones = [
        {
          title: state.activeSession ? 'OMX 실행 중' : (snapshot.current_session_id ? '세션 감지됨' : '대기 중'),
          meta: state.activeSession ? state.activeSession.session_id : (snapshot.current_session_id || snapshot.cwd || ''),
          state: state.activeSession ? 'active' : (snapshot.current_session_id ? 'done' : '')
        },
        {
          title: (snapshot.hud_text || 'HUD 준비').trim(),
          meta: snapshot.generated_at ? 'Updated ' + formatTime(snapshot.generated_at) : '',
          state: snapshot.hud_text ? 'done' : ''
        },
        {
          title: latestAssistant ? actionTitle(latestAssistant.text || '') : '최근 결과 없음',
          meta: latestAssistant ? formatTime(latestAssistant.created_at) : (history[0] ? 'Last session ' + formatTime(history[0].started_at) : ''),
          state: latestAssistant ? 'done' : ''
        }
      ];
      for (const item of milestones) {
        const row = document.createElement('div');
        row.className = 'milestone ' + item.state;
        const dot = document.createElement('div');
        dot.className = 'milestone-dot';
        const body = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'milestone-title';
        title.textContent = item.title;
        const meta = document.createElement('div');
        meta.className = 'status-card-meta';
        meta.textContent = item.meta || '';
        body.appendChild(title);
        body.appendChild(meta);
        row.appendChild(dot);
        row.appendChild(body);
        list.appendChild(row);
      }
      card.appendChild(list);
      return card;
    }

    function metricSummary(metrics) {
      if (!metrics) return 'No metrics';
      const total = typeof metrics.session_total_tokens === 'number' ? metrics.session_total_tokens : undefined;
      return total ? total + ' tokens' : (metrics.session_turns || metrics.total_turns || 0) + ' turns';
    }

    function metricMeta(metrics) {
      if (!metrics) return 'No .omx metrics yet';
      const parts = [];
      if (typeof metrics.five_hour_limit_pct === 'number') parts.push('5h ' + metrics.five_hour_limit_pct + '%');
      if (typeof metrics.weekly_limit_pct === 'number') parts.push('week ' + metrics.weekly_limit_pct + '%');
      if (metrics.last_activity) parts.push('last ' + formatTime(metrics.last_activity));
      return parts.join(' · ');
    }

    function extractActiveModes(hud) {
      const keys = ['ralph', 'ultragoal', 'ultrawork', 'autopilot', 'ralplan', 'deepInterview', 'autoresearch', 'codeReview', 'ultraqa', 'team'];
      const labels = {
        deepInterview: 'deep-interview',
        codeReview: 'code-review'
      };
      return keys.filter((key) => hud[key] && hud[key].active).map((key) => labels[key] || key);
    }

    function renderConversations(conversations, activeId) {
      conversationsEl.textContent = '';
      if (!conversations.length) {
        appendEmpty(conversationsEl, 'No conversations.');
        return;
      }
      for (const item of conversations) {
        const row = document.createElement('div');
        row.className = 'history-entry';
        const button = document.createElement('button');
        button.className = 'item' + (item.id === activeId ? ' active' : '');
        appendItemText(button, item.title, formatTime(item.updated_at) + ' · ' + item.message_count + ' messages');
        button.addEventListener('click', () => {
          historyOpen = false;
          document.body.classList.remove('history-open');
          requestBottomScroll();
          post('selectConversation', { conversationId: item.id });
        });
        row.appendChild(button);
        conversationsEl.appendChild(row);
      }
    }

    function renderOmxSessions(sessions) {
      omxSessionsEl.textContent = '';
      if (!sessions.length) {
        appendEmpty(omxSessionsEl, 'No session history.');
        return;
      }
      for (const item of sessions) {
        const row = document.createElement('div');
        row.className = 'history-entry';
        const button = document.createElement('button');
        button.className = 'item';
        appendItemText(
          button,
          item.session_id,
          formatTime(item.started_at) + (item.ended_at ? ' · ended ' + formatTime(item.ended_at) : '') + (item.pid ? ' · pid ' + item.pid : '') + (item.log_path ? ' · log available' : '')
        );
        button.addEventListener('click', () => {
          historyOpen = false;
          document.body.classList.remove('history-open');
          requestBottomScroll();
          post('selectOmxSession', { sessionId: item.session_id });
        });
        row.appendChild(button);
        const actions = document.createElement('div');
        actions.className = 'history-entry-actions';
        if (item.log_path) {
          actions.appendChild(historyAction('Log', () => {
            historyOpen = false;
            document.body.classList.remove('history-open');
            post('openLog', { logPath: item.log_path });
          }));
        }
        if (item.source_path) {
          actions.appendChild(historyAction('Source', () => post('openLog', { logPath: item.source_path })));
        }
        if (actions.childElementCount) row.appendChild(actions);
        omxSessionsEl.appendChild(row);
      }
    }

    function renderEventLogs(logs) {
      renderLogList(eventLogsEl, logs, 'No event logs.');
    }

    function renderLogs(logs) {
      renderLogList(vscodeLogsEl, logs, 'No VSCode logs.');
    }

    function renderLogList(container, logs, emptyText) {
      container.textContent = '';
      if (!logs.length) {
        appendEmpty(container, emptyText);
        return;
      }
      for (const log of logs) {
        const row = document.createElement('div');
        row.className = 'history-entry';
        const button = document.createElement('button');
        button.className = 'item';
        appendItemText(button, log.name, formatTime(log.updated_at) + ' · ' + log.bytes + ' bytes');
        button.addEventListener('click', () => {
          historyOpen = false;
          document.body.classList.remove('history-open');
          post('openLog', { logPath: log.path });
        });
        row.appendChild(button);
        container.appendChild(row);
      }
    }

    function appendItemText(button, titleText, metaText) {
      const title = document.createElement('span');
      title.textContent = titleText;
      button.appendChild(title);
      if (metaText) {
        const meta = document.createElement('span');
        meta.className = 'item-meta';
        meta.textContent = metaText;
        button.appendChild(meta);
      }
    }

    function historyAction(label, handler) {
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }

    function renderMessages(messages, activeSession, shouldScrollAfterRender) {
      messageListEl.textContent = '';
      if (!messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = activeSession ? 'Session ' + activeSession.session_id + ' is active.' : '대화 로그가 여기에 표시됩니다.';
        messageListEl.appendChild(empty);
        if (shouldScrollAfterRender) scrollToBottom();
        return;
      }
      for (const message of messages) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message ' + message.role;
        const role = document.createElement('div');
        role.className = 'role';
        role.textContent = message.role + ' · ' + formatTime(message.created_at);
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        renderMessageBody(bubble, message);
        wrapper.appendChild(role);
        wrapper.appendChild(bubble);
        if (message.log_path) {
          const actions = document.createElement('div');
          actions.className = 'message-actions';
          const logButton = document.createElement('button');
          logButton.className = 'link-button';
          logButton.textContent = 'Open log';
          logButton.addEventListener('click', () => post('openLog', { logPath: message.log_path }));
          actions.appendChild(logButton);
          wrapper.appendChild(actions);
        }
        messageListEl.appendChild(wrapper);
      }
      if (shouldScrollAfterRender) scrollToBottom();
    }

    function renderMessageBody(container, message) {
      const text = message.text || '';
      const workMessage = parseWorkMessage(text);
      if (message.role !== 'user' && workMessage) {
        renderWorkMessage(container, message, workMessage);
        return;
      }
      if (!shouldCollapseMessage(message, text)) {
        container.textContent = text;
        return;
      }

      container.textContent = '';
      const details = document.createElement('details');
      details.className = 'action-details';
      const key = messageActionKey(message);
      details.open = expandedActionKeys.has(key);
      const summary = document.createElement('summary');
      const title = document.createElement('span');
      title.className = 'action-title';
      title.textContent = actionTitle(text);
      const meta = document.createElement('span');
      meta.className = 'action-meta';
      meta.textContent = actionMeta(text);
      summary.appendChild(title);
      summary.appendChild(meta);

      const body = document.createElement('div');
      body.className = 'action-body';
      body.textContent = text;

      details.appendChild(summary);
      details.appendChild(body);
      restoreActionBodyScroll(body, key);
      body.addEventListener('scroll', () => {
        actionBodyScrollPositions.set(key, body.scrollTop);
      });
      details.addEventListener('toggle', () => {
        if (details.open) {
          expandedActionKeys.add(key);
          restoreActionBodyScroll(body, key);
        } else {
          expandedActionKeys.delete(key);
          actionBodyScrollPositions.set(key, body.scrollTop);
        }
        window.requestAnimationFrame(() => {
          stickToBottom = isNearBottom();
        });
      });
      container.appendChild(details);
    }

    function parseWorkMessage(text) {
      const marker = '\\n상세:\\n';
      const markerIndex = text.indexOf(marker);
      if (markerIndex < 0) return null;
      const head = text.slice(0, markerIndex).trim();
      const details = text.slice(markerIndex + marker.length).trim();
      const headLines = head.split(/\\r?\\n/);
      const title = (headLines.shift() || '작업 진행').trim();
      let summary = headLines.join('\\n').trim();
      summary = summary.replace(/^핵심:\\s*/m, '').trim();
      if (!summary) summary = '• 핵심 진행 내용을 기다리는 중입니다.';
      const status = title.includes('⏳') || /진행 중/.test(title)
        ? 'running'
        : (title.includes('⚠') || title.includes('⏹') || /failed|실패|오류|취소/i.test(title) ? 'failed' : 'success');
      return { title, summary, details, status };
    }

    function renderWorkMessage(container, message, parsed) {
      container.textContent = '';
      const card = document.createElement('div');
      card.className = 'work-card';

      const header = document.createElement('div');
      header.className = 'work-card-header';
      const spinner = document.createElement('span');
      spinner.className = 'work-spinner ' + parsed.status;
      const title = document.createElement('div');
      title.className = 'work-title';
      title.textContent = parsed.title;
      header.appendChild(spinner);
      header.appendChild(title);

      const summary = document.createElement('div');
      summary.className = 'work-summary';
      summary.textContent = parsed.summary;

      const details = document.createElement('details');
      details.className = 'action-details work-details';
      const key = messageActionKey(message) + '|work-details';
      details.open = expandedActionKeys.has(key);
      const detailsSummary = document.createElement('summary');
      const detailsTitle = document.createElement('span');
      detailsTitle.className = 'action-title';
      detailsTitle.textContent = parsed.status === 'running' ? '상세 출력 갱신 중' : '상세 출력';
      const meta = document.createElement('span');
      meta.className = 'action-meta';
      meta.textContent = actionMeta(parsed.details || '');
      detailsSummary.appendChild(detailsTitle);
      detailsSummary.appendChild(meta);
      const body = document.createElement('div');
      body.className = 'action-body';
      body.textContent = parsed.details || '(상세 출력 없음)';

      details.appendChild(detailsSummary);
      details.appendChild(body);
      restoreActionBodyScroll(body, key);
      body.addEventListener('scroll', () => {
        actionBodyScrollPositions.set(key, body.scrollTop);
      });
      details.addEventListener('toggle', () => {
        if (details.open) {
          expandedActionKeys.add(key);
          restoreActionBodyScroll(body, key);
        } else {
          expandedActionKeys.delete(key);
          actionBodyScrollPositions.set(key, body.scrollTop);
        }
        window.requestAnimationFrame(() => {
          stickToBottom = isNearBottom();
        });
      });

      card.appendChild(header);
      card.appendChild(summary);
      card.appendChild(details);
      container.appendChild(card);
    }

    function messageActionKey(message) {
      return message.id || [message.role, message.created_at, message.session_id || '', message.log_path || '', String(message.text || '').slice(0, 96)].join('|');
    }

    function pruneExpandedActionKeys(messages) {
      const currentKeys = new Set();
      for (const message of messages) {
        const key = messageActionKey(message);
        currentKeys.add(key);
        currentKeys.add(key + '|work-details');
      }
      for (const key of Array.from(expandedActionKeys)) {
        if (!currentKeys.has(key)) expandedActionKeys.delete(key);
      }
      for (const key of Array.from(actionBodyScrollPositions.keys())) {
        if (!currentKeys.has(key)) actionBodyScrollPositions.delete(key);
      }
    }

    function restoreActionBodyScroll(body, key) {
      const scrollTop = actionBodyScrollPositions.get(key);
      if (typeof scrollTop !== 'number') return;
      window.requestAnimationFrame(() => {
        body.scrollTop = scrollTop;
      });
    }

    function isNearBottom() {
      return scrollAreaEl.scrollHeight - scrollAreaEl.clientHeight - scrollAreaEl.scrollTop <= 96;
    }

    function requestBottomScroll() {
      stickToBottom = true;
      forceNextScrollToBottom = true;
    }

    function scrollToBottom() {
      scrollAreaEl.scrollTop = scrollAreaEl.scrollHeight;
      stickToBottom = true;
    }

    function shouldCollapseMessage(message, text) {
      if (message.role === 'user') return false;
      const lineCount = text.split(/\\r?\\n/).filter((line) => line.trim()).length;
      if (text.length > 900 || lineCount > 12) return true;
      return /(^|\\n)(Command:|Exit:|Log:|Stderr:|\\[stderr\\]|Started OMX|OMX team status:|OMX session:)/.test(text)
        || /\\b(rg|grep|find|fd)\\b.*\\n/.test(text)
        || /\\b(read_file|search_files|list_files|execute_command|function_call|function_call_output)\\b/.test(text)
        || /^\\s*[\\[{]/.test(text.trim());
    }

    function actionTitle(text) {
      const lines = text.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
      const commandLine = lines.find((line) => /^Command: /.test(line));
      if (commandLine) return commandLine.replace(/^Command: /, '');
      const startLine = lines.find((line) => /^Started OMX /.test(line));
      if (startLine) return startLine;
      const teamLine = lines.find((line) => /^OMX team status: /.test(line));
      if (teamLine) return teamLine;
      const sessionLine = lines.find((line) => /^OMX session: /.test(line));
      if (sessionLine) return sessionLine;
      const stderrLine = lines.find((line) => /^\\[stderr\\]/.test(line) || /^Stderr:/.test(line));
      if (stderrLine) return 'stderr output';
      const fileSearchLine = lines.find((line) => /\\b(rg|grep|find|fd)\\b/.test(line));
      if (fileSearchLine) return fileSearchLine.length > 96 ? fileSearchLine.slice(0, 93) + '...' : fileSearchLine;
      const first = lines[0] || 'Action output';
      return first.length > 96 ? first.slice(0, 93) + '...' : first;
    }

    function actionMeta(text) {
      const lines = text.split(/\\r?\\n/);
      const exitLine = lines.find((line) => /^Exit: /.test(line.trim()));
      if (exitLine) return exitLine.trim();
      const logLine = lines.find((line) => /^Log: /.test(line.trim()));
      if (logLine) return 'log attached';
      const nonEmpty = lines.filter((line) => line.trim()).length;
      return nonEmpty + ' lines';
    }

    function appendEmpty(container, text) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = text;
      container.appendChild(empty);
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'error') {
        messageListEl.innerHTML = '';
        const error = document.createElement('div');
        error.className = 'error';
        error.textContent = message.message;
        messageListEl.appendChild(error);
        return;
      }
      if (message.type === 'state') renderState(message.state);
    });
  </script>
</body>
</html>`;
}

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderChatHtml } from './chatHtml';
import {
  appendMessage,
  createConversation,
  listConversations,
  readConversation,
  updateMessage,
  type ChatConversation,
  type ChatConversationSummary,
} from './chatStore';
import { normalizeWebviewMessage } from './chatProtocol';
import { formatSessionMessage, trimTranscript } from './sessionTranscript';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';
import type { DirectSessionHandle } from './types';
import { listVscodeLogs, realPathInsideWorkspace, type VscodeLogSummary } from './workspaceStatus';

interface ChatViewState {
  activeConversationId: string | null;
  conversations: ChatConversationSummary[];
  conversation: ChatConversation | null;
  activeSession: {
    session_id: string;
    log_path: string;
    started_at: string;
  } | null;
  logs: VscodeLogSummary[];
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
    webviewView.webview.html = renderChatHtml(randomUUID());
    const disposables: vscode.Disposable[] = [];
    webviewView.onDidDispose(() => {
      for (const disposable of disposables) disposable.dispose();
      this.view = null;
    }, null, this.context.subscriptions);
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    }, null, disposables);
    void this.refresh();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.omx');
    await vscode.commands.executeCommand('omx.chat.focus').then(undefined, () => undefined);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    try {
      await this.view.webview.postMessage({ type: 'state', state: await this.buildState() });
    } catch (error) {
      await this.view.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async buildState(): Promise<ChatViewState> {
    const cwd = getWorkspaceRoot();
    const [conversations, logs] = await Promise.all([listConversations(cwd), listVscodeLogs(cwd, 8)]);
    if (!this.activeConversationId && conversations[0]) this.activeConversationId = conversations[0].id;
    const conversation = this.activeConversationId ? await readConversation(cwd, this.activeConversationId) : null;
    if (this.activeConversationId && !conversation) this.activeConversationId = null;
    const active = this.sessionManager.active;
    return {
      activeConversationId: conversation?.id ?? null,
      conversations,
      conversation,
      activeSession: active
        ? { session_id: active.session_id, log_path: active.log_path, started_at: active.started_at }
        : null,
      logs,
    };
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = normalizeWebviewMessage(rawMessage);
    if (!message) return;
    switch (message.command) {
      case 'send':
        await this.send(message.text ?? '');
        break;
      case 'newConversation':
        this.activeConversationId = (await createConversation(getWorkspaceRoot())).id;
        await this.refresh();
        break;
      case 'selectConversation':
        this.activeConversationId = message.conversationId ?? null;
        await this.refresh();
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
        await this.refresh();
        break;
      case 'refresh':
        await this.refresh();
        break;
    }
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    const cwd = getWorkspaceRoot();
    const conversation = await this.ensureConversation(text);
    await appendMessage(cwd, conversation.id, { role: 'user', text });

    if (this.sessionManager.active) {
      await appendMessage(cwd, conversation.id, {
        role: 'system',
        text: 'An OMX session is already running. Stop it before sending another prompt.',
      });
      await this.refresh();
      return;
    }

    const pending = await appendMessage(cwd, conversation.id, {
      role: 'assistant',
      text: 'Starting OMX session...',
    });
    const responseId = pending.messages[pending.messages.length - 1]?.id;
    let transcript = '';
    let handle: DirectSessionHandle | null = null;
    let terminalStatus: string | null = null;
    let updateQueue: Promise<void> = Promise.resolve();
    const updateResponse = async (status: string): Promise<void> => {
      if (!responseId) return;
      await updateMessage(cwd, conversation.id, responseId, {
        text: formatSessionMessage(status, handle, transcript),
        session_id: handle?.session_id,
        log_path: handle?.log_path,
      });
      await this.refresh();
    };
    const scheduleResponseUpdate = (status: string): void => {
      updateQueue = updateQueue
        .catch(() => undefined)
        .then(() => updateResponse(status));
      void updateQueue.catch((error) => {
        this.output.appendLine(`[omx] chat update failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    await this.refresh();

    try {
      handle = await this.sessionManager.start('launch', text, {
        onOutput: (_stream, chunk) => {
          transcript = trimTranscript(`${transcript}${chunk}`);
          scheduleResponseUpdate('Running');
        },
        onExit: (code, signal) => {
          terminalStatus = `Exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
          scheduleResponseUpdate(terminalStatus);
        },
        onError: (error) => {
          terminalStatus = `Launch error: ${error.message}`;
          scheduleResponseUpdate(terminalStatus);
        },
      });
      if (handle) {
        if (!terminalStatus) scheduleResponseUpdate('Running');
        await updateQueue;
      } else if (responseId) {
        await updateMessage(cwd, conversation.id, responseId, { text: 'Launch cancelled.' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[omx] chat launch failed: ${message}`);
      if (responseId) {
        await updateMessage(cwd, conversation.id, responseId, { text: `Launch failed:\n${message}` });
      } else {
        await appendMessage(cwd, conversation.id, { role: 'assistant', text: `Launch failed:\n${message}` });
      }
    }
    await this.refresh();
  }

  private async ensureConversation(initialText: string): Promise<ChatConversation> {
    const cwd = getWorkspaceRoot();
    if (this.activeConversationId) {
      const existing = await readConversation(cwd, this.activeConversationId);
      if (existing) return existing;
    }
    const created = await createConversation(cwd, initialText);
    this.activeConversationId = created.id;
    return created;
  }

  private async openLog(logPath: string | undefined): Promise<void> {
    if (!logPath) return;
    const cwd = getWorkspaceRoot();
    if (!await realPathInsideWorkspace(cwd, logPath)) {
      await vscode.window.showErrorMessage('OMX refused to open a log outside the active workspace.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(logPath)));
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

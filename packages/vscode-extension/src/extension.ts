import * as vscode from 'vscode';
import { OmxChatViewProvider } from './chatView';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';

let refreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('OMX');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let chatView: OmxChatViewProvider;
  let sessionManager: OmxSessionManager;

  const refreshAll = async () => {
    await chatView.refresh();
    refreshStatusBar(statusBar, sessionManager);
  };
  sessionManager = new OmxSessionManager(context, output, () => {
    void refreshAll();
  });
  chatView = new OmxChatViewProvider(context, sessionManager, output);

  statusBar.command = 'omx.openChat';
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Open OMX Chat';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerWebviewViewProvider('omx.chat', chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('omx.openChat', async () => {
      await chatView.reveal();
    }),
    vscode.commands.registerCommand('omx.start', async () => {
      await sessionManager.promptAndStart('launch');
      await refreshAll();
    }),
    vscode.commands.registerCommand('omx.resume', async () => {
      await sessionManager.promptAndStart('resume');
      await refreshAll();
    }),
    vscode.commands.registerCommand('omx.stop', async () => {
      sessionManager.stop();
      await refreshAll();
    }),
    vscode.commands.registerCommand('omx.doctor', async () => {
      await sessionManager.doctor();
      await refreshAll();
    }),
  );

  registerWorkspaceWatchers(context, refreshAll);
  configureRefreshTimer(context, refreshAll);
  void refreshAll();
}

export function deactivate(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function refreshStatusBar(statusBar: vscode.StatusBarItem, sessionManager: OmxSessionManager): void {
  const active = sessionManager.active;
  if (active) {
    statusBar.text = `OMX: ${active.session_id}`;
    statusBar.tooltip = `Running in ${getWorkspaceRoot()}\nLog: ${active.log_path}`;
    return;
  }
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Open OMX Chat';
}

function configureRefreshTimer(context: vscode.ExtensionContext, refreshAll: () => Promise<void>): void {
  const intervalMs = Math.max(500, vscode.workspace.getConfiguration('omx').get<number>('refreshIntervalMs', 1500));
  refreshTimer = setInterval(() => {
    void refreshAll();
  }, intervalMs);
  context.subscriptions.push({ dispose: () => refreshTimer && clearInterval(refreshTimer) });
}

function registerWorkspaceWatchers(context: vscode.ExtensionContext, refreshAll: () => Promise<void>): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  for (const pattern of ['.omx/logs/**', '.omx/vscode/**']) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
    watcher.onDidCreate(() => void refreshAll(), null, context.subscriptions);
    watcher.onDidChange(() => void refreshAll(), null, context.subscriptions);
    watcher.onDidDelete(() => void refreshAll(), null, context.subscriptions);
    context.subscriptions.push(watcher);
  }
}

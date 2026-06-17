import * as vscode from 'vscode';
import { OmxDashboard } from './dashboard';
import { OmxChatViewProvider } from './chatView';
import { OmxControlCenter } from './controlCenter';
import { loadOmxCore } from './core';
import { OmxLogExplorer } from './logExplorer';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';

let refreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('OMX');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'omx.openChat';
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Open OMX Chat';
  statusBar.show();

  let dashboard: OmxDashboard;
  let controlCenter: OmxControlCenter;
  let logExplorer: OmxLogExplorer;
  let chatView: OmxChatViewProvider;
  const refreshAll = async () => {
    await dashboard.refresh();
    await controlCenter.refresh();
    await logExplorer.refresh();
    await chatView.refresh();
    await refreshStatusBar(context, statusBar);
  };
  const sessionManager = new OmxSessionManager(context, output, () => {
    void refreshAll();
  });
  dashboard = new OmxDashboard(context, sessionManager, output);
  controlCenter = new OmxControlCenter(context, sessionManager, output);
  logExplorer = new OmxLogExplorer(context);
  chatView = new OmxChatViewProvider(context, sessionManager, output);

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerWebviewViewProvider('omx.chat', chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('omx.openChat', async () => {
      try {
        await chatView.reveal();
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Unable to open OMX Chat. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.commands.registerCommand('omx.openDashboard', async () => {
      await dashboard.open();
    }),
    vscode.commands.registerCommand('omx.openControlCenter', async () => {
      await controlCenter.open();
    }),
    vscode.commands.registerCommand('omx.openLogExplorer', async () => {
      await logExplorer.open();
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
    }),
    vscode.commands.registerCommand('omx.team.status', async (teamName?: string) => {
      await showTeamStatus(context, output, teamName);
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
  for (const pattern of ['.omx/state/**', '.omx/ultragoal/**', '.omx/logs/**', '.omx/vscode/**']) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
    watcher.onDidCreate(() => void refreshAll(), null, context.subscriptions);
    watcher.onDidChange(() => void refreshAll(), null, context.subscriptions);
    watcher.onDidDelete(() => void refreshAll(), null, context.subscriptions);
    context.subscriptions.push(watcher);
  }
}

async function refreshStatusBar(context: vscode.ExtensionContext, statusBar: vscode.StatusBarItem): Promise<void> {
  try {
    const core = await loadOmxCore(context);
    const snapshot = await core.readWorkspaceSnapshot({ cwd: getWorkspaceRoot(), maxLogs: 1 });
    const text = snapshot.hud_text.trim() || 'OMX idle';
    statusBar.text = `OMX: ${text.length > 48 ? `${text.slice(0, 45)}...` : text}`;
    statusBar.tooltip = snapshot.current_session_id
      ? `OMX session ${snapshot.current_session_id}`
      : 'Open OMX Chat';
  } catch {
    statusBar.text = 'OMX: setup required';
    statusBar.tooltip = 'Run root npm build or configure omx.coreModulePath';
  }
}

async function showTeamStatus(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  teamName?: string,
): Promise<void> {
  try {
    const core = await loadOmxCore(context);
    const cwd = getWorkspaceRoot();
    const snapshot = await core.readWorkspaceSnapshot({ cwd, maxLogs: 1 });
    const selectedTeam = teamName ?? await vscode.window.showQuickPick(snapshot.teams.map((team) => team.name), {
      title: 'Select OMX team',
    });
    if (!selectedTeam) return;
    const status = await core.readTeamSnapshot({ cwd, teamName: selectedTeam, refreshMonitor: false });
    output.show(true);
    output.appendLine(`[omx] team status ${selectedTeam}`);
    output.appendLine(JSON.stringify(status, null, 2));
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

import * as vscode from 'vscode';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('OMX');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const sessionManager = new OmxSessionManager(context, output, () => {
    refreshStatusBar(statusBar, sessionManager);
  });

  statusBar.command = 'omx.start';
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Start an OMX direct session';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('omx.start', async () => {
      await sessionManager.promptAndStart('launch');
    }),
    vscode.commands.registerCommand('omx.resume', async () => {
      await sessionManager.promptAndStart('resume');
    }),
    vscode.commands.registerCommand('omx.stop', () => {
      sessionManager.stop();
    }),
    vscode.commands.registerCommand('omx.doctor', async () => {
      await sessionManager.doctor();
    }),
  );

  refreshStatusBar(statusBar, sessionManager);
}

export function deactivate(): void {
  // Child processes are owned by OmxSessionManager and stopped through the command surface.
}

function refreshStatusBar(statusBar: vscode.StatusBarItem, sessionManager: OmxSessionManager): void {
  const active = sessionManager.active;
  if (active) {
    statusBar.text = `OMX: ${active.session_id}`;
    statusBar.tooltip = `Running in ${getWorkspaceRoot()}\nLog: ${active.log_path}`;
    return;
  }
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Start an OMX direct session';
}

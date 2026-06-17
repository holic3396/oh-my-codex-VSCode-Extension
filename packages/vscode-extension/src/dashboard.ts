import * as vscode from 'vscode';
import { loadOmxCore } from './core';
import { listOmxHistory, type OmxHistorySnapshot } from './historyStore';
import { uiStrings } from './i18n';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';
import type { LogExplorerSnapshot, WorkspaceSnapshot } from './types';

interface DashboardActiveSession {
  session_id: string;
  pid?: number;
  log_path: string;
  started_at: string;
}

interface DashboardWebviewState {
  snapshot: WorkspaceSnapshot;
  history: OmxHistorySnapshot;
  logExplorer: LogExplorerSnapshot;
  activeSession: DashboardActiveSession | null;
}

export class OmxDashboard {
  private panel: vscode.WebviewPanel | null = null;
  private latestSnapshot: WorkspaceSnapshot | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: OmxSessionManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'omxDashboard',
      'OMX Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.panel.webview.html = renderDashboardHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = null;
    }, null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(async (message: {
      command?: string;
      prompt?: string;
      teamName?: string;
      logPath?: string;
      line?: number;
    }) => {
      switch (message.command) {
        case 'start':
          await this.sessionManager.start('launch', message.prompt?.trim() || undefined);
          await this.refresh();
          break;
        case 'resume':
          await this.sessionManager.start('resume', message.prompt?.trim() || undefined);
          await this.refresh();
          break;
        case 'stop':
          this.sessionManager.stop();
          await this.refresh();
          break;
        case 'doctor':
          await this.sessionManager.doctor();
          break;
        case 'refresh':
          await this.refresh();
          break;
        case 'teamStatus':
          await this.showTeamStatus(message.teamName);
          break;
        case 'openLog':
          await this.openLog(message.logPath, message.line);
          break;
        case 'openLogExplorer':
          await vscode.commands.executeCommand('omx.openLogExplorer');
          break;
        case 'openChat':
          await vscode.commands.executeCommand('omx.openChat');
          break;
      }
    }, null, this.context.subscriptions);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    try {
      const cwd = getWorkspaceRoot();
      const core = await loadOmxCore(this.context);
      const [snapshot, history, logExplorer] = await Promise.all([
        core.readWorkspaceSnapshot({ cwd, maxLogs: 30 }),
        listOmxHistory(cwd, 40),
        core.readLogExplorerSnapshot({ cwd, limit: 80 }),
      ]);
      this.latestSnapshot = snapshot;
      const state: DashboardWebviewState = {
        snapshot,
        history,
        logExplorer,
        activeSession: this.sessionManager.active
          ? {
            session_id: this.sessionManager.active.session_id,
            pid: this.sessionManager.active.pid,
            log_path: this.sessionManager.active.log_path,
            started_at: this.sessionManager.active.started_at,
          }
          : null,
      };
      await this.panel.webview.postMessage({ type: 'state', state });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async showTeamStatus(teamName: string | undefined): Promise<void> {
    const selectedTeam = teamName || await this.pickTeamName();
    if (!selectedTeam) return;
    try {
      const core = await loadOmxCore(this.context);
      const status = await core.readTeamSnapshot({ cwd: getWorkspaceRoot(), teamName: selectedTeam, refreshMonitor: false });
      this.output.show(true);
      this.output.appendLine(`[omx] team status ${selectedTeam}`);
      this.output.appendLine(JSON.stringify(status, null, 2));
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async openLog(logPath: string | undefined, line: number | undefined): Promise<void> {
    if (!logPath) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    const selection = typeof line === 'number' && Number.isFinite(line)
      ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
      : undefined;
    await vscode.window.showTextDocument(document, { preview: true, selection });
  }

  private async pickTeamName(): Promise<string | undefined> {
    const teams = this.latestSnapshot?.teams ?? [];
    if (teams.length === 0) {
      void vscode.window.showInformationMessage('No OMX team state found in this workspace.');
      return undefined;
    }
    return vscode.window.showQuickPick(teams.map((team) => team.name), {
      title: 'Select OMX team',
    });
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function renderDashboardHtml(webview: vscode.Webview): string {
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
  <title>OMX Dashboard</title>
  <style>
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
    button, input { font: inherit; }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 6px 9px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.link {
      padding: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      border: 0;
      font-size: 11px;
    }
    button:hover { border-color: var(--vscode-focusBorder); }
    input {
      flex: 1 1 320px;
      min-width: 180px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 7px 9px;
    }
    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      height: 100vh;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .title {
      font-weight: 700;
      margin-right: 6px;
    }
    .content {
      min-height: 0;
      overflow: auto;
      padding: 14px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(280px, 0.95fr) minmax(360px, 1.35fr) minmax(320px, 1.1fr);
      gap: 12px;
      align-items: start;
    }
    section, .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, transparent);
      padding: 12px;
      min-width: 0;
    }
    section { margin-bottom: 12px; }
    h2 {
      margin: 0 0 9px;
      font-size: 13px;
      font-weight: 700;
    }
    h3 {
      margin: 0 0 5px;
      font-size: 12px;
      font-weight: 700;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      max-height: 280px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.4;
    }
    details summary {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      margin-top: 8px;
    }
    .card-title {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
      margin-bottom: 5px;
    }
    .card-main {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .meta, .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.45;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      border-top: 1px solid var(--vscode-panel-border);
      padding: 9px 0;
    }
    .row:first-child { border-top: 0; padding-top: 0; }
    .row-actions {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .badge {
      display: inline-block;
      margin: 2px 4px 2px 0;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 400;
    }
    .preview {
      margin-top: 5px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-foreground);
      line-height: 1.45;
    }
    .timeline {
      display: grid;
      gap: 8px;
    }
    .timeline-row {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .dot {
      width: 9px;
      height: 9px;
      margin-top: 4px;
      border-radius: 999px;
      background: var(--vscode-descriptionForeground);
    }
    .dot.active { background: var(--vscode-testing-iconQueued); }
    .dot.done { background: var(--vscode-testing-iconPassed); }
    .error {
      color: var(--vscode-errorForeground);
      padding: 8px 0 12px;
    }
    @media (max-width: 1120px) {
      .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="toolbar">
      <div class="title">OMX Dashboard</div>
      <input id="prompt" placeholder="작업 프롬프트를 입력하고 Start/Resume을 누르세요">
      <button id="start">${strings.startWork}</button>
      <button id="resume" class="secondary">${strings.resumeWork}</button>
      <button id="stop" class="secondary">${strings.stop}</button>
      <button id="doctor" class="secondary">${strings.doctor}</button>
      <button id="openLogs" class="secondary">${strings.openLogExplorer}</button>
      <button id="openChat" class="secondary">${strings.chatTitle}</button>
      <button id="refresh" class="secondary">${strings.refresh}</button>
    </header>
    <main class="content">
      <div id="error" class="error"></div>
      <div id="summary" class="summary-grid"></div>
      <div class="layout">
        <div>
          <section>
            <h2>${strings.currentWork}</h2>
            <div id="currentWork"></div>
          </section>
          <section>
            <h2>${strings.milestones}</h2>
            <div id="progress"></div>
          </section>
          <section>
            <h2>${strings.teams}</h2>
            <div id="teams"></div>
          </section>
        </div>
        <div>
          <section>
            <h2>Previous Work</h2>
            <div id="history"></div>
          </section>
          <section>
            <h2>Subagents</h2>
            <div id="subagents"></div>
          </section>
        </div>
        <div>
          <section>
            <h2>Recent Log Entries</h2>
            <div id="recentLogs"></div>
          </section>
          <section>
            <h2>Log Files</h2>
            <div id="logFiles"></div>
          </section>
        </div>
      </div>
    </main>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const promptInput = document.getElementById('prompt');
    const errorEl = document.getElementById('error');
    const summaryEl = document.getElementById('summary');
    const currentWorkEl = document.getElementById('currentWork');
    const progressEl = document.getElementById('progress');
    const teamsEl = document.getElementById('teams');
    const historyEl = document.getElementById('history');
    const subagentsEl = document.getElementById('subagents');
    const recentLogsEl = document.getElementById('recentLogs');
    const logFilesEl = document.getElementById('logFiles');

    function send(command, extra) {
      vscode.postMessage({ command, prompt: promptInput.value, ...(extra || {}) });
    }
    document.getElementById('start').addEventListener('click', () => send('start'));
    document.getElementById('resume').addEventListener('click', () => send('resume'));
    document.getElementById('stop').addEventListener('click', () => send('stop'));
    document.getElementById('doctor').addEventListener('click', () => send('doctor'));
    document.getElementById('refresh').addEventListener('click', () => send('refresh'));
    document.getElementById('openLogs').addEventListener('click', () => send('openLogExplorer'));
    document.getElementById('openChat').addEventListener('click', () => send('openChat'));

    function formatTime(value) {
      if (!value) return '';
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }
    function duration(start, end) {
      const started = Date.parse(start || '');
      const ended = end ? Date.parse(end) : Date.now();
      if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return '';
      const totalSeconds = Math.floor((ended - started) / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours) return hours + 'h ' + minutes + 'm';
      if (minutes) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }
    function clear(element) { element.textContent = ''; }
    function empty(container, text) {
      clear(container);
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      container.appendChild(node);
    }
    function card(title, main, meta) {
      const node = document.createElement('div');
      node.className = 'card';
      const titleEl = document.createElement('div');
      titleEl.className = 'card-title';
      titleEl.textContent = title;
      const mainEl = document.createElement('div');
      mainEl.className = 'card-main';
      mainEl.textContent = main || 'Unknown';
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = meta || '';
      node.appendChild(titleEl);
      node.appendChild(mainEl);
      node.appendChild(metaEl);
      return node;
    }
    function action(label, command, extra) {
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = label;
      button.addEventListener('click', () => send(command, extra));
      return button;
    }
    function appendRow(container, title, meta, actions, preview) {
      const row = document.createElement('div');
      row.className = 'row';
      const body = document.createElement('div');
      const titleEl = document.createElement('h3');
      titleEl.textContent = title;
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = meta || '';
      body.appendChild(titleEl);
      body.appendChild(metaEl);
      if (preview) {
        const previewEl = document.createElement('div');
        previewEl.className = 'preview';
        previewEl.textContent = preview;
        body.appendChild(previewEl);
      }
      row.appendChild(body);
      if (actions && actions.length) {
        const actionWrap = document.createElement('div');
        actionWrap.className = 'row-actions';
        for (const item of actions) actionWrap.appendChild(item);
        row.appendChild(actionWrap);
      }
      container.appendChild(row);
    }
    function metricSummary(metrics) {
      if (!metrics) return ['No metrics', 'No .omx metrics yet'];
      const total = typeof metrics.session_total_tokens === 'number' ? metrics.session_total_tokens : undefined;
      const turns = metrics.session_turns || metrics.total_turns || 0;
      const main = total ? total + ' tokens' : turns + ' turns';
      const parts = [];
      if (typeof metrics.five_hour_limit_pct === 'number') parts.push('5h ' + metrics.five_hour_limit_pct + '%');
      if (typeof metrics.weekly_limit_pct === 'number') parts.push('week ' + metrics.weekly_limit_pct + '%');
      if (metrics.last_activity) parts.push('last ' + formatTime(metrics.last_activity));
      return [main, parts.join(' · ')];
    }
    function extractActiveModes(hud) {
      const keys = ['ralph', 'ultragoal', 'ultrawork', 'autopilot', 'ralplan', 'deepInterview', 'autoresearch', 'codeReview', 'ultraqa', 'team'];
      const labels = { deepInterview: 'deep-interview', codeReview: 'code-review' };
      return keys.filter((key) => hud && hud[key] && hud[key].active).map((key) => labels[key] || key);
    }
    function renderSummary(state) {
      clear(summaryEl);
      const snapshot = state.snapshot || {};
      const hud = snapshot.hud || {};
      const metrics = metricSummary(hud.metrics);
      const active = state.activeSession;
      const currentId = snapshot.current_session_id || (active && active.session_id) || '';
      summaryEl.appendChild(card('Runtime', active ? 'Running' : (currentId ? 'Session detected' : 'Idle'), currentId || snapshot.cwd || 'No workspace state'));
      summaryEl.appendChild(card('HUD', (snapshot.hud_text || 'OMX idle').trim(), snapshot.generated_at ? 'Updated ' + formatTime(snapshot.generated_at) : ''));
      summaryEl.appendChild(card('Metrics', metrics[0], metrics[1]));
      const modes = extractActiveModes(hud);
      summaryEl.appendChild(card('Modes', modes.length ? modes.join(', ') : 'None active', modes.length ? 'Mode state from .omx/state' : 'No active workflow mode'));
      const logCount = state.logExplorer && state.logExplorer.logs ? state.logExplorer.logs.length : (snapshot.logs || []).length;
      const latestLog = state.logExplorer && state.logExplorer.logs && state.logExplorer.logs[0];
      summaryEl.appendChild(card('Logs', logCount + ' files', latestLog ? latestLog.name + ' · ' + formatTime(latestLog.updated_at) : 'No log files yet'));
    }
    function renderCurrentWork(state) {
      clear(currentWorkEl);
      const snapshot = state.snapshot || {};
      const active = state.activeSession;
      if (active) {
        appendRow(currentWorkEl, active.session_id, 'pid ' + (active.pid || 'unknown') + ' · started ' + formatTime(active.started_at) + ' · running ' + duration(active.started_at), [action('Open log', 'openLog', { logPath: active.log_path })]);
      } else if (snapshot.current_session_id) {
        appendRow(currentWorkEl, snapshot.current_session_id, 'Workspace session detected from .omx/state', []);
      } else {
        empty(currentWorkEl, 'No active VSCode-launched session. Use Start/Resume or inspect Previous Work below.');
      }
      if (snapshot.hud) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'HUD details';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(snapshot.hud, null, 2);
        details.appendChild(summary);
        details.appendChild(pre);
        currentWorkEl.appendChild(details);
      }
    }
    function renderProgress(state) {
      clear(progressEl);
      const snapshot = state.snapshot || {};
      const latestSession = state.history && state.history.sessions && state.history.sessions[0];
      const latestLog = state.logExplorer && state.logExplorer.recent && state.logExplorer.recent[0];
      const rows = [
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
          title: latestSession ? 'Latest finished work: ' + latestSession.session_id : 'No previous session history',
          meta: latestSession ? formatTime(latestSession.started_at) + (latestSession.ended_at ? ' · duration ' + duration(latestSession.started_at, latestSession.ended_at) : '') : '',
          state: latestSession ? 'done' : ''
        },
        {
          title: latestLog ? 'Latest log: ' + latestLog.name : 'No recent log entries',
          meta: latestLog ? formatTime(latestLog.timestamp || latestLog.updated_at) : '',
          state: latestLog ? 'done' : ''
        }
      ];
      const timeline = document.createElement('div');
      timeline.className = 'timeline';
      for (const item of rows) {
        const row = document.createElement('div');
        row.className = 'timeline-row';
        const dot = document.createElement('div');
        dot.className = 'dot ' + item.state;
        const body = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = item.title;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = item.meta || '';
        body.appendChild(title);
        body.appendChild(meta);
        row.appendChild(dot);
        row.appendChild(body);
        timeline.appendChild(row);
      }
      progressEl.appendChild(timeline);
    }
    function renderTeams(teams) {
      clear(teamsEl);
      if (!teams || !teams.length) return empty(teamsEl, 'No OMX team state found.');
      for (const team of teams) {
        appendRow(teamsEl, team.name, 'Updated ' + formatTime(team.updated_at), [action('Status', 'teamStatus', { teamName: team.name })]);
      }
    }
    function renderHistory(history) {
      clear(historyEl);
      const sessions = history && history.sessions ? history.sessions : [];
      if (!sessions.length) return empty(historyEl, 'No session history.');
      for (const session of sessions.slice(0, 14)) {
        const actions = [];
        if (session.log_path) actions.push(action('Log', 'openLog', { logPath: session.log_path }));
        if (session.source_path) actions.push(action('History', 'openLog', { logPath: session.source_path }));
        const meta = [
          'Started ' + formatTime(session.started_at),
          session.ended_at ? 'ended ' + formatTime(session.ended_at) : 'not ended',
          session.ended_at ? 'duration ' + duration(session.started_at, session.ended_at) : '',
          session.pid ? 'pid ' + session.pid : '',
          session.cwd || ''
        ].filter(Boolean).join(' · ');
        appendRow(historyEl, session.session_id, meta, actions);
      }
    }
    function renderSubagents(history) {
      clear(subagentsEl);
      const sessions = history && history.subagents ? history.subagents : [];
      if (!sessions.length) return empty(subagentsEl, 'No subagent tracking summary.');
      for (const session of sessions.slice(0, 8)) {
        const threadSummary = (session.threads || []).map((thread) => {
          const status = thread.active ? 'active' : (thread.completed_at ? 'done' : 'seen');
          return thread.kind + ' ' + thread.thread_id + ' · ' + status + ' · ' + thread.turn_count + ' turns';
        }).join('\n');
        appendRow(
          subagentsEl,
          session.session_id,
          session.active_subagents + ' active · ' + session.completed_subagents + ' completed · updated ' + formatTime(session.updated_at),
          [],
          threadSummary
        );
      }
    }
    function renderRecentLogs(logExplorer) {
      clear(recentLogsEl);
      const entries = logExplorer && logExplorer.recent ? logExplorer.recent : [];
      if (!entries.length) return empty(recentLogsEl, 'No recent log entries.');
      for (const entry of entries.slice(0, 18)) {
        const title = entry.name + (entry.line ? ':' + entry.line : '');
        const tags = [entry.source, entry.level, entry.team, entry.worker, entry.task_id, entry.session_id].filter(Boolean);
        const meta = formatTime(entry.timestamp || entry.updated_at) + (tags.length ? ' · ' + tags.join(' · ') : '');
        appendRow(recentLogsEl, title, meta, [action('Open', 'openLog', { logPath: entry.path, line: entry.line })], entry.preview || entry.message);
      }
    }
    function renderLogFiles(logExplorer, snapshot) {
      clear(logFilesEl);
      const logs = logExplorer && logExplorer.logs ? logExplorer.logs : (snapshot.logs || []);
      if (!logs.length) return empty(logFilesEl, 'No OMX logs found.');
      for (const log of logs.slice(0, 24)) {
        appendRow(logFilesEl, log.name, (log.source ? log.source + ' · ' : '') + log.bytes + ' bytes · ' + formatTime(log.updated_at), [action('Open', 'openLog', { logPath: log.path })]);
      }
      const openExplorer = document.createElement('button');
      openExplorer.className = 'secondary';
      openExplorer.textContent = 'Open full Log Explorer';
      openExplorer.addEventListener('click', () => send('openLogExplorer'));
      logFilesEl.appendChild(openExplorer);
    }
    function renderState(state) {
      errorEl.textContent = '';
      renderSummary(state);
      renderCurrentWork(state);
      renderProgress(state);
      renderTeams((state.snapshot && state.snapshot.teams) || []);
      renderHistory(state.history || {});
      renderSubagents(state.history || {});
      renderRecentLogs(state.logExplorer || {});
      renderLogFiles(state.logExplorer || {}, state.snapshot || {});
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'error') {
        errorEl.textContent = message.message;
        return;
      }
      if (message.type === 'state') renderState(message.state || {});
    });
  </script>
</body>
</html>`;
}

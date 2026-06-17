import * as vscode from 'vscode';
import { loadOmxCore } from './core';
import { uiStrings } from './i18n';
import { getWorkspaceRoot } from './sessionManager';
import type { LogEntry, LogExplorerSnapshot } from './types';

export class OmxLogExplorer {
  private panel: vscode.WebviewPanel | null = null;
  private latestSnapshot: LogExplorerSnapshot | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel('omxLogExplorer', uiStrings().logExplorerTitle, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = renderLogExplorerHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = null;
    }, null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage((message: {
      command?: string;
      filters?: Record<string, string | number | undefined>;
      path?: string;
      line?: number;
    }) => {
      void this.handleMessage(message);
    }, null, this.context.subscriptions);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    try {
      const core = await loadOmxCore(this.context);
      this.latestSnapshot = await core.readLogExplorerSnapshot({ cwd: getWorkspaceRoot(), limit: 60 });
      await this.panel.webview.postMessage({ type: 'snapshot', snapshot: this.latestSnapshot });
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleMessage(message: {
    command?: string;
    filters?: Record<string, string | number | undefined>;
    path?: string;
    line?: number;
  }): Promise<void> {
    switch (message.command) {
      case 'refresh':
        await this.refresh();
        break;
      case 'search':
        await this.search(message.filters ?? {});
        break;
      case 'openLog':
        await this.openLog(message.path, message.line);
        break;
    }
  }

  private async search(filters: Record<string, string | number | undefined>): Promise<void> {
    if (!this.panel) return;
    try {
      const core = await loadOmxCore(this.context);
      const entries = await core.searchOmxLogs({
        cwd: getWorkspaceRoot(),
        query: asFilterString(filters.query),
        source: asFilterString(filters.source),
        team: asFilterString(filters.team),
        worker: asFilterString(filters.worker),
        task_id: asFilterString(filters.task_id),
        session_id: asFilterString(filters.session_id),
        since: asFilterString(filters.since),
        until: asFilterString(filters.until),
        limit: typeof filters.limit === 'number' ? filters.limit : 100,
      });
      await this.panel.webview.postMessage({ type: 'results', entries });
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async openLog(logPath: string | undefined, line: number | undefined): Promise<void> {
    if (!logPath) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(document, {
      preview: true,
      selection: typeof line === 'number' && Number.isFinite(line)
        ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
        : undefined,
    });
  }
}

function asFilterString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function renderLogExplorerHtml(webview: vscode.Webview): string {
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
  <title>${strings.logExplorerTitle}</title>
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
    button, input, select { font: inherit; }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 5px 8px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    input, select {
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      padding: 5px 7px;
      min-width: 0;
    }
    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      height: 100vh;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1.5fr) minmax(120px, 0.7fr) repeat(4, minmax(90px, 0.7fr)) auto auto;
      gap: 8px;
      align-items: end;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .field label {
      display: block;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .content {
      display: grid;
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
      min-height: 0;
    }
    .sidebar, .results {
      min-height: 0;
      overflow: auto;
      padding: 12px;
    }
    .sidebar {
      border-right: 1px solid var(--vscode-panel-border);
    }
    .section-title {
      margin: 0 0 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .log-file, .entry {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 8px;
      background: transparent;
    }
    .entry-title {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      font-weight: 600;
    }
    .badge {
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 400;
    }
    .meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 4px;
    }
    .preview {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 8px 0 0;
      line-height: 1.45;
      color: var(--vscode-foreground);
    }
    .empty, .error {
      color: var(--vscode-descriptionForeground);
      padding: 10px;
    }
    .error { color: var(--vscode-errorForeground); }
    @media (max-width: 980px) {
      .toolbar { grid-template-columns: 1fr 1fr; }
      .content { grid-template-columns: 1fr; overflow: auto; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="toolbar">
      <div class="field"><label>${strings.query}</label><input id="query" placeholder="${strings.logSearch}"></div>
      <div class="field"><label>${strings.source}</label><select id="source"></select></div>
      <div class="field"><label>Team</label><input id="team"></div>
      <div class="field"><label>Worker</label><input id="worker"></div>
      <div class="field"><label>Task</label><input id="task"></div>
      <div class="field"><label>Session</label><input id="session"></div>
      <button id="search">${strings.logSearch}</button>
      <button id="refresh" class="secondary">${strings.refresh}</button>
    </header>
    <main class="content">
      <aside class="sidebar">
        <h2 class="section-title">Files</h2>
        <div id="files"></div>
      </aside>
      <section class="results">
        <h2 class="section-title">Results</h2>
        <div id="results"></div>
      </section>
    </main>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    let snapshot = null;
    const sourceEl = document.getElementById('source');
    const filesEl = document.getElementById('files');
    const resultsEl = document.getElementById('results');
    const sourceOptions = ['all', 'vscode', 'omx', 'team-events', 'session-history', 'state', 'other'];
    for (const source of sourceOptions) {
      const option = document.createElement('option');
      option.value = source;
      option.textContent = source === 'all' ? '${strings.all}' : source;
      sourceEl.appendChild(option);
    }
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('search').addEventListener('click', search);
    document.getElementById('query').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search();
    });

    function post(command, extra = {}) {
      vscode.postMessage({ command, ...extra });
    }
    function search() {
      post('search', {
        filters: {
          query: document.getElementById('query').value,
          source: document.getElementById('source').value,
          team: document.getElementById('team').value,
          worker: document.getElementById('worker').value,
          task_id: document.getElementById('task').value,
          session_id: document.getElementById('session').value,
          limit: 120
        }
      });
    }
    function formatTime(value) {
      if (!value) return '';
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }
    function renderFiles(logs) {
      filesEl.textContent = '';
      if (!logs.length) {
        filesEl.textContent = 'No OMX logs found.';
        return;
      }
      for (const log of logs) {
        const row = document.createElement('div');
        row.className = 'log-file';
        row.textContent = log.name;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = log.source + ' · ' + log.bytes + ' bytes · ' + formatTime(log.updated_at);
        row.appendChild(meta);
        row.addEventListener('click', () => post('openLog', { path: log.path }));
        filesEl.appendChild(row);
      }
    }
    function renderEntries(entries) {
      resultsEl.textContent = '';
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No matching log entries.';
        resultsEl.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const card = document.createElement('article');
        card.className = 'entry';
        const title = document.createElement('div');
        title.className = 'entry-title';
        const name = document.createElement('span');
        name.textContent = entry.name + (entry.line ? ':' + entry.line : '');
        title.appendChild(name);
        for (const value of [entry.source, entry.level, entry.team, entry.worker, entry.task_id].filter(Boolean)) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = value;
          title.appendChild(badge);
        }
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = formatTime(entry.timestamp || entry.updated_at);
        const preview = document.createElement('div');
        preview.className = 'preview';
        preview.textContent = entry.preview || entry.message;
        const actions = document.createElement('div');
        actions.className = 'meta';
        const open = document.createElement('button');
        open.className = 'secondary';
        open.textContent = '${strings.openLog}';
        open.addEventListener('click', () => post('openLog', { path: entry.path, line: entry.line }));
        actions.appendChild(open);
        card.appendChild(title);
        card.appendChild(meta);
        card.appendChild(preview);
        card.appendChild(actions);
        resultsEl.appendChild(card);
      }
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'error') {
        resultsEl.innerHTML = '';
        const error = document.createElement('div');
        error.className = 'error';
        error.textContent = message.message;
        resultsEl.appendChild(error);
        return;
      }
      if (message.type === 'snapshot') {
        snapshot = message.snapshot;
        renderFiles(snapshot.logs || []);
        renderEntries(snapshot.recent || []);
        return;
      }
      if (message.type === 'results') {
        renderEntries(message.entries || []);
      }
    });
  </script>
</body>
</html>`;
}

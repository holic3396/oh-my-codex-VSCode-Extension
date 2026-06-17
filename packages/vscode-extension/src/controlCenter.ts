import * as vscode from 'vscode';
import { COMMAND_CATALOG, buildCatalogArgs, commandById } from './commandCatalog';
import { loadOmxCore } from './core';
import { uiStrings } from './i18n';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';
import type { ControlCenterSnapshot } from './types';

export class OmxControlCenter {
  private panel: vscode.WebviewPanel | null = null;
  private latestSnapshot: ControlCenterSnapshot | null = null;

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

    this.panel = vscode.window.createWebviewPanel('omxControlCenter', uiStrings().controlCenterTitle, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = renderControlCenterHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = null;
    }, null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage((message: {
      command?: string;
      target?: string;
      role?: string;
      text?: string;
      catalogId?: string;
      values?: Record<string, string | number | boolean | undefined>;
    }) => {
      void this.handleMessage(message);
    }, null, this.context.subscriptions);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    try {
      const core = await loadOmxCore(this.context);
      this.latestSnapshot = await core.readControlCenterSnapshot({
        cwd: getWorkspaceRoot(),
        maxLogs: 20,
        refreshMonitor: false,
        eventLimit: 20,
      });
      await this.panel.webview.postMessage({
        type: 'state',
        snapshot: this.latestSnapshot,
        catalog: COMMAND_CATALOG.map((entry) => ({
          id: entry.id,
          title: entry.title,
          category: entry.category,
          description: entry.description,
          fields: entry.fields,
          risk: entry.risk,
          preview: entry.preview,
        })),
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMessage(message: {
    command?: string;
    target?: string;
    role?: string;
    text?: string;
    catalogId?: string;
    values?: Record<string, string | number | boolean | undefined>;
  }): Promise<void> {
    switch (message.command) {
      case 'refresh':
        await this.refresh();
        break;
      case 'capturePane':
        await this.capturePane(message.target);
        break;
      case 'sendPaneInput':
        await this.sendPaneInput(message.target, message.role, message.text);
        break;
      case 'runCatalog':
        await this.runCatalogCommand(message.catalogId, message.values ?? {});
        break;
      case 'openLogExplorer':
        await vscode.commands.executeCommand('omx.openLogExplorer');
        break;
      case 'openChat':
        await vscode.commands.executeCommand('omx.openChat');
        break;
    }
  }

  private async capturePane(target: string | undefined): Promise<void> {
    if (!target || !this.panel) return;
    try {
      const core = await loadOmxCore(this.context);
      const tail = core.captureTmuxPaneTail({ target, lines: 180 });
      await this.panel.webview.postMessage({ type: 'paneTail', tail });
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async sendPaneInput(target: string | undefined, role: string | undefined, text: string | undefined): Promise<void> {
    if (!target || !text?.trim()) return;
    if (role && role !== 'leader') {
      const choice = await vscode.window.showWarningMessage(
        `Send input to ${role} pane ${target}? Worker pane input can interfere with running tasks.`,
        { modal: true },
        'Send',
      );
      if (choice !== 'Send') return;
    }
    try {
      const core = await loadOmxCore(this.context);
      const result = core.sendTmuxPaneInput({ target, text, submit: true });
      this.output.appendLine(`[omx] sent ${result.bytes} bytes to ${target}`);
      await this.capturePane(target);
      await this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async runCatalogCommand(
    catalogId: string | undefined,
    values: Record<string, string | number | boolean | undefined>,
  ): Promise<void> {
    if (!catalogId) return;
    const entry = commandById(catalogId);
    if (!entry) return;
    let args: string[];
    try {
      args = buildCatalogArgs(catalogId, values);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }

    const prompt = [
      entry.risk === 'safe' ? uiStrings().confirmRun : uiStrings().confirmDangerous,
      '',
      `omx ${args.join(' ')}`,
      '',
      entry.description,
    ].join('\n');
    const choice = await vscode.window.showWarningMessage(prompt, { modal: entry.risk !== 'safe' }, 'Run');
    if (choice !== 'Run') return;

    try {
      const result = await this.sessionManager.runCommand(args, `catalog-${entry.id}`);
      this.output.show(true);
      this.output.appendLine(`[omx] catalog command ${entry.id} exited code=${result.code ?? 'null'}`);
      await this.panel?.webview.postMessage({
        type: 'catalogResult',
        result: {
          id: entry.id,
          args,
          code: result.code,
          stdout: result.stdout.slice(0, 8_000),
          stderr: result.stderr.slice(0, 4_000),
          log_path: result.log_path,
        },
      });
      await this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function renderControlCenterHtml(webview: vscode.Webview): string {
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
  <title>${strings.controlCenterTitle}</title>
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
    button, input, select, textarea {
      font: inherit;
    }
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
    input, select, textarea {
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      padding: 5px 7px;
    }
    textarea {
      min-height: 64px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
    }
    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      height: 100vh;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .title { font-weight: 700; }
    .spacer { flex: 1; }
    .layout {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(360px, 1fr) minmax(300px, 380px);
      min-height: 0;
    }
    .pane {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      border-right: 1px solid var(--vscode-panel-border);
      padding: 12px;
    }
    .pane:last-child { border-right: 0; }
    .section { margin-bottom: 14px; }
    .section-title {
      margin: 0 0 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .item {
      width: 100%;
      display: block;
      margin: 0 0 6px;
      padding: 8px;
      text-align: left;
      color: var(--vscode-foreground);
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
    }
    .item.active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .meta, .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 3px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      min-height: 58px;
    }
    .metric b { display: block; font-size: 16px; }
    .tail {
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 240px;
      max-height: 46vh;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      background: var(--vscode-editorWidget-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.4;
    }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .form { display: grid; gap: 8px; }
    .field label {
      display: block;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .result {
      white-space: pre-wrap;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      max-height: 220px;
      overflow: auto;
      color: var(--vscode-descriptionForeground);
    }
    .error { color: var(--vscode-errorForeground); padding: 8px 12px; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; overflow: auto; }
      .pane { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="title">${strings.controlCenterTitle}</div>
      <div id="subtitle" class="meta"></div>
      <div class="spacer"></div>
      <button id="openChat" class="secondary">${strings.chatTitle}</button>
      <button id="openLogs" class="secondary">${strings.openLogExplorer}</button>
      <button id="refresh">${strings.refresh}</button>
    </header>
    <main class="layout">
      <aside class="pane">
        <section class="section">
          <h2 class="section-title">${strings.teams}</h2>
          <div id="teams"></div>
        </section>
        <section class="section">
          <h2 class="section-title">${strings.tmuxPanes}</h2>
          <div id="panes"></div>
        </section>
      </aside>
      <section class="pane">
        <div class="section">
          <h2 class="section-title">${strings.currentWork}</h2>
          <div id="metrics" class="metric-grid"></div>
        </div>
        <div class="section">
          <h2 class="section-title">${strings.workers}</h2>
          <div id="workers"></div>
        </div>
        <div class="section">
          <h2 class="section-title">${strings.tasks}</h2>
          <div id="tasks"></div>
        </div>
        <div class="section">
          <h2 class="section-title">${strings.paneTail}</h2>
          <pre id="tail" class="tail">Select a tmux pane.</pre>
          <div class="form" style="margin-top: 8px;">
            <textarea id="paneInput" placeholder="${strings.sendToLeader}"></textarea>
            <button id="sendPane">${strings.sendToLeader}</button>
          </div>
        </div>
      </section>
      <aside class="pane">
        <section class="section">
          <h2 class="section-title">${strings.commandLauncher}</h2>
          <select id="catalogSelect"></select>
          <div id="catalogDescription" class="meta"></div>
          <div id="catalogForm" class="form" style="margin-top: 10px;"></div>
          <div class="row" style="margin-top: 10px;">
            <button id="runCatalog">${strings.run}</button>
          </div>
          <pre id="catalogResult" class="result" style="margin-top: 10px;"></pre>
        </section>
      </aside>
    </main>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    let snapshot = null;
    let catalog = [];
    let selectedTeam = '';
    let selectedPane = null;
    let selectedPaneRole = 'leader';
    const teamsEl = document.getElementById('teams');
    const panesEl = document.getElementById('panes');
    const metricsEl = document.getElementById('metrics');
    const workersEl = document.getElementById('workers');
    const tasksEl = document.getElementById('tasks');
    const tailEl = document.getElementById('tail');
    const paneInputEl = document.getElementById('paneInput');
    const catalogSelectEl = document.getElementById('catalogSelect');
    const catalogFormEl = document.getElementById('catalogForm');
    const catalogDescriptionEl = document.getElementById('catalogDescription');
    const catalogResultEl = document.getElementById('catalogResult');
    const subtitleEl = document.getElementById('subtitle');

    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('openLogs').addEventListener('click', () => post('openLogExplorer'));
    document.getElementById('openChat').addEventListener('click', () => post('openChat'));
    document.getElementById('sendPane').addEventListener('click', () => {
      if (!selectedPane) return;
      post('sendPaneInput', { target: selectedPane.id, role: selectedPaneRole, text: paneInputEl.value });
      paneInputEl.value = '';
    });
    document.getElementById('runCatalog').addEventListener('click', () => {
      const values = {};
      const entry = catalog.find((item) => item.id === catalogSelectEl.value);
      if (!entry) return;
      for (const field of entry.fields) {
        const el = document.querySelector('[data-field="' + field.name + '"]');
        if (!el) continue;
        values[field.name] = field.type === 'boolean' ? el.checked : field.type === 'number' ? Number(el.value) : el.value;
      }
      post('runCatalog', { catalogId: entry.id, values });
    });
    catalogSelectEl.addEventListener('change', renderCatalogForm);

    function post(command, extra = {}) {
      vscode.postMessage({ command, ...extra });
    }
    function formatTime(value) {
      if (!value) return '';
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }
    function setEmpty(container, text) {
      container.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = text;
      container.appendChild(empty);
    }
    function metric(label, value, meta) {
      const node = document.createElement('div');
      node.className = 'metric';
      const valueEl = document.createElement('b');
      valueEl.textContent = value;
      const labelEl = document.createElement('div');
      labelEl.textContent = label;
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = meta || '';
      node.appendChild(valueEl);
      node.appendChild(labelEl);
      node.appendChild(metaEl);
      return node;
    }
    function selectedTeamSnapshot() {
      const teams = snapshot ? snapshot.teams || [] : [];
      if (!selectedTeam && teams[0]) selectedTeam = teams[0].name;
      return teams.find((team) => team.name === selectedTeam) || teams[0] || null;
    }
    function render() {
      if (!snapshot) return;
      subtitleEl.textContent = snapshot.workspace.cwd + ' · ' + formatTime(snapshot.generated_at);
      renderTeams();
      renderPanes();
      renderMetrics();
      renderWorkers();
      renderTasks();
      renderCatalog();
    }
    function renderTeams() {
      teamsEl.textContent = '';
      const teams = snapshot.teams || [];
      if (!teams.length) return setEmpty(teamsEl, 'No team state.');
      if (!selectedTeam) selectedTeam = teams[0].name;
      for (const team of teams) {
        const button = document.createElement('button');
        button.className = 'item' + (team.name === selectedTeam ? ' active' : '');
        button.textContent = team.name;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = (team.sidecar && team.sidecar.topology ? team.sidecar.topology.summary : 'No sidecar snapshot') + ' · ' + formatTime(team.updated_at);
        button.appendChild(meta);
        button.addEventListener('click', () => {
          selectedTeam = team.name;
          render();
        });
        teamsEl.appendChild(button);
      }
    }
    function paneRole(pane) {
      for (const team of snapshot.teams || []) {
        for (const mapping of (team.sidecar && team.sidecar.panes) || []) {
          if (mapping.pane_id === pane.id) return mapping.role;
        }
      }
      return 'leader';
    }
    function renderPanes() {
      panesEl.textContent = '';
      if (!snapshot.tmux.available) return setEmpty(panesEl, snapshot.tmux.error || 'tmux unavailable');
      const panes = snapshot.tmux.panes || [];
      if (!panes.length) return setEmpty(panesEl, 'No panes.');
      for (const pane of panes) {
        const role = paneRole(pane);
        const button = document.createElement('button');
        button.className = 'item' + (selectedPane && selectedPane.id === pane.id ? ' active' : '');
        button.textContent = pane.id + ' · ' + role;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = pane.session + ':' + pane.window + '.' + pane.pane + ' · ' + pane.current_command;
        button.appendChild(meta);
        button.addEventListener('click', () => {
          selectedPane = pane;
          selectedPaneRole = role;
          post('capturePane', { target: pane.id });
          renderPanes();
        });
        panesEl.appendChild(button);
      }
    }
    function renderMetrics() {
      metricsEl.textContent = '';
      const team = selectedTeamSnapshot();
      const sidecar = team && team.sidecar;
      const tasks = sidecar ? sidecar.tasks || [] : [];
      const workers = sidecar ? sidecar.workers || [] : [];
      metricsEl.appendChild(metric('Status', snapshot.workspace.hud_text || 'OMX idle', snapshot.workspace.current_session_id || 'No session'));
      metricsEl.appendChild(metric('Workers', String(workers.length), sidecar ? sidecar.phase || 'phase unknown' : 'No team'));
      metricsEl.appendChild(metric('Tasks', String(tasks.length), tasks.filter((t) => t.status === 'in_progress').length + ' in progress'));
      metricsEl.appendChild(metric('Highlights', String(sidecar ? sidecar.highlights.length : 0), sidecar ? sidecar.highlights.map((h) => h.kind).slice(0, 2).join(', ') : ''));
    }
    function renderWorkers() {
      workersEl.textContent = '';
      const sidecar = selectedTeamSnapshot() && selectedTeamSnapshot().sidecar;
      const workers = sidecar ? sidecar.workers || [] : [];
      if (!workers.length) return setEmpty(workersEl, 'No workers.');
      for (const worker of workers) {
        const row = document.createElement('div');
        row.className = 'item';
        row.textContent = worker.name + ' · ' + worker.role + ' · ' + worker.status.state;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = (worker.current_task ? 'task-' + worker.current_task.id + ' · ' + worker.current_task.subject : 'No current task') + (worker.pane_id ? ' · ' + worker.pane_id : '');
        row.appendChild(meta);
        workersEl.appendChild(row);
      }
    }
    function renderTasks() {
      tasksEl.textContent = '';
      const sidecar = selectedTeamSnapshot() && selectedTeamSnapshot().sidecar;
      const tasks = sidecar ? sidecar.tasks || [] : [];
      if (!tasks.length) return setEmpty(tasksEl, 'No tasks.');
      for (const task of tasks) {
        const row = document.createElement('div');
        row.className = 'item';
        row.textContent = 'task-' + task.id + ' · ' + task.status + ' · ' + task.subject;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = [task.owner, task.role, task.error || task.result].filter(Boolean).join(' · ');
        row.appendChild(meta);
        tasksEl.appendChild(row);
      }
    }
    function renderCatalog() {
      if (!catalogSelectEl.options.length) {
        for (const entry of catalog) {
          const option = document.createElement('option');
          option.value = entry.id;
          option.textContent = entry.title + ' · ' + entry.category;
          catalogSelectEl.appendChild(option);
        }
      }
      renderCatalogForm();
    }
    function renderCatalogForm() {
      const entry = catalog.find((item) => item.id === catalogSelectEl.value) || catalog[0];
      if (!entry) return;
      catalogDescriptionEl.textContent = entry.description + ' · ' + entry.preview + ' · risk=' + entry.risk;
      catalogFormEl.textContent = '';
      for (const field of entry.fields) {
        const wrap = document.createElement('div');
        wrap.className = 'field';
        const label = document.createElement('label');
        label.textContent = field.label + (field.required ? ' *' : '');
        let input;
        if (field.type === 'select') {
          input = document.createElement('select');
          for (const option of field.options || []) {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            input.appendChild(opt);
          }
          input.value = field.defaultValue || '';
        } else {
          input = document.createElement('input');
          input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text';
          if (field.placeholder) input.placeholder = field.placeholder;
          if (field.type === 'boolean') input.checked = field.defaultValue === true;
          else if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
        }
        input.dataset.field = field.name;
        wrap.appendChild(label);
        wrap.appendChild(input);
        catalogFormEl.appendChild(wrap);
      }
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'error') {
        catalogResultEl.textContent = message.message;
        return;
      }
      if (message.type === 'state') {
        snapshot = message.snapshot;
        catalog = message.catalog || [];
        render();
        return;
      }
      if (message.type === 'paneTail') {
        tailEl.textContent = message.tail.body || '(no output)';
        return;
      }
      if (message.type === 'catalogResult') {
        const r = message.result;
        catalogResultEl.textContent = 'omx ' + r.args.join(' ') + '\\nExit: ' + r.code + '\\nLog: ' + r.log_path + '\\n\\n' + (r.stdout || '') + (r.stderr ? '\\nStderr:\\n' + r.stderr : '');
      }
    });
  </script>
</body>
</html>`;
}

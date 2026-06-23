export function renderChatHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .app { display: grid; grid-template-rows: auto auto 1fr auto auto; height: 100vh; min-width: 0; }
    .toolbar, .session, .composer, .logs { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .toolbar { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; }
    .session { display: grid; gap: 6px; color: var(--vscode-descriptionForeground); }
    .session-row { display: flex; gap: 6px; align-items: center; min-width: 0; }
    .session-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
    .messages { overflow: auto; padding: 10px 8px; }
    .message { margin: 0 0 12px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 4px; }
    .bubble { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; line-height: 1.45; }
    .user .bubble { background: var(--vscode-input-background); }
    .assistant .bubble { background: var(--vscode-editorWidget-background); }
    .system .bubble { color: var(--vscode-descriptionForeground); }
    .composer { display: grid; grid-template-columns: 1fr auto; gap: 6px; border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
    textarea, select, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    textarea { min-height: 64px; max-height: 180px; resize: vertical; padding: 8px; }
    button { padding: 5px 8px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-button-secondaryBackground); }
    button.primary { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    button:disabled { opacity: 0.55; cursor: default; }
    select { width: 100%; min-width: 0; padding: 5px 6px; }
    .logs { display: grid; gap: 6px; border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; max-height: 25vh; overflow: auto; }
    .log-item { width: 100%; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty, .error { color: var(--vscode-descriptionForeground); padding: 10px 2px; }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="app">
    <div class="toolbar">
      <select id="conversation"></select>
      <button id="new">New</button>
      <button id="refresh">Refresh</button>
    </div>
    <div class="session">
      <div class="session-row"><span id="sessionState">Idle</span><span id="sessionId" class="session-id"></span></div>
      <div class="session-row"><button id="stop">Stop</button><button id="doctor">Doctor</button><button id="activeLog">Open log</button></div>
    </div>
    <div id="messages" class="messages"></div>
    <form id="form" class="composer"><textarea id="input" rows="3"></textarea><button id="send" class="primary" type="submit">Send</button></form>
    <div id="logs" class="logs"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const conversationEl = document.getElementById('conversation');
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const stopEl = document.getElementById('stop');
    const activeLogEl = document.getElementById('activeLog');
    const sessionStateEl = document.getElementById('sessionState');
    const sessionIdEl = document.getElementById('sessionId');
    const logsEl = document.getElementById('logs');
    let latestState = null;

    document.getElementById('new').addEventListener('click', () => post('newConversation'));
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('doctor').addEventListener('click', () => post('doctor'));
    stopEl.addEventListener('click', () => post('stop'));
    activeLogEl.addEventListener('click', () => {
      if (latestState && latestState.activeSession) post('openLog', { logPath: latestState.activeSession.log_path });
    });
    conversationEl.addEventListener('change', () => post('selectConversation', { conversationId: conversationEl.value }));
    document.getElementById('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = inputEl.value;
      inputEl.value = '';
      post('send', { text });
    });

    function post(command, payload = {}) { vscode.postMessage({ command, ...payload }); }

    function renderState(state) {
      latestState = state;
      renderConversations(state);
      renderSession(state.activeSession);
      renderMessages(state.conversation ? state.conversation.messages || [] : []);
      renderLogs(state.logs || []);
    }

    function renderConversations(state) {
      conversationEl.textContent = '';
      if (!state.conversations || state.conversations.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'New conversation';
        conversationEl.appendChild(option);
        return;
      }
      for (const item of state.conversations) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.title + ' (' + item.message_count + ')';
        option.selected = item.id === state.activeConversationId;
        conversationEl.appendChild(option);
      }
    }

    function renderSession(active) {
      const running = Boolean(active);
      sessionStateEl.textContent = running ? 'Running' : 'Idle';
      sessionIdEl.textContent = running ? active.session_id : '';
      stopEl.disabled = !running;
      activeLogEl.disabled = !running;
      sendEl.disabled = running;
      inputEl.disabled = running;
    }

    function renderMessages(messages) {
      messagesEl.textContent = '';
      if (!messages.length) {
        messagesEl.appendChild(empty('No messages yet.'));
        return;
      }
      for (const message of messages) {
        const row = document.createElement('div');
        row.className = 'message ' + message.role;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = message.role + ' · ' + new Date(message.created_at).toLocaleString();
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = message.text || '';
        row.appendChild(meta);
        row.appendChild(bubble);
        if (message.log_path) {
          const open = document.createElement('button');
          open.textContent = 'Open log';
          open.addEventListener('click', () => post('openLog', { logPath: message.log_path }));
          row.appendChild(open);
        }
        messagesEl.appendChild(row);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderLogs(logs) {
      logsEl.textContent = '';
      if (!logs.length) return;
      for (const log of logs) {
        const button = document.createElement('button');
        button.className = 'log-item';
        button.textContent = log.name;
        button.addEventListener('click', () => post('openLog', { logPath: log.path }));
        logsEl.appendChild(button);
      }
    }

    function empty(text) {
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      return node;
    }

    window.addEventListener('message', (event) => {
      if (event.data.type === 'state') renderState(event.data.state);
      if (event.data.type === 'error') {
        messagesEl.textContent = '';
        const node = empty(event.data.message);
        node.className = 'error';
        messagesEl.appendChild(node);
      }
    });
  </script>
</body>
</html>`;
}

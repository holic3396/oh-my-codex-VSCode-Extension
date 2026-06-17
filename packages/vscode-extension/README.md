# Oh My Codex VSCode Extension

Desktop VSCode UI for OMX sessions. The default surface is Chat, with separate Control Center and Log Explorer screens for operational visibility.

## Development

1. Build the root OMX package:

   ```bash
   npm run build
   ```

2. Compile the extension:

   ```bash
   cd packages/vscode-extension
   npm install
   npm run compile
   ```

3. Launch the extension host from VSCode using this package as the extension folder.

The extension loads the root core module from `../../dist/vscode/index.js` by default. Set `omx.coreModulePath` when using a packaged or globally installed core module.

## Usage

1. Open an OMX project folder in desktop VSCode.
2. Open the OMX Activity Bar view. Chat is the primary view.
3. Enter a normal task prompt and press Send.
4. Use **Control Center** for sessions, teams, workers, tasks, tmux panes, and the form-based OMX launcher.
5. Use **Log Explorer** to search `.omx/logs`, VSCode logs, session history, and team events.
6. Use `OMX: Run Doctor` when launch fails.

The chat composer runs through OMX's non-interactive exec surface so the extension can capture output and save it into conversation history. When an exec job is still active, the next message uses `omx exec inject <session-id> --prompt <text>` to queue a follow-up. When no exec job is active, the extension starts a new `omx exec` turn with recent conversation history included as context. Dashboard Start/Resume still use direct interactive launch. The chat composer does not interpret Codex terminal slash commands. Put launch flags in `omx.defaultArgs`, for example:

```json
{
  "omx.defaultArgs": ["--model", "gpt-5.5"]
}
```

If VSCode cannot find `codex`, add the binary directory to `omx.extraPath`. The extension already prepends common macOS locations including `/Applications/Codex.app/Contents/Resources`.

Conversations are saved under `.omx/vscode/conversations`. Existing run history is read from `.omx/logs/vscode`.

## MVP Scope

- Direct OMX start/resume through `OMX_LAUNCH_POLICY=direct`.
- Activity Bar chat, session tree, Control Center, Log Explorer, dashboard webview, status bar summary, and raw Output Channel logs.
- Active exec follow-up injection through OMX's audited `omx exec inject` queue.
- File-backed refresh from `.omx/state/**`, `.omx/ultragoal/**`, and `.omx/logs/**`.
- Control Center renders team sidecar snapshots and can safely mirror tmux pane tails.
- Log Explorer uses on-demand structured search without persisting an index.
- Codex terminal slash commands are not a VSCode UI feature yet; they require a future pseudoterminal/stdin bridge.

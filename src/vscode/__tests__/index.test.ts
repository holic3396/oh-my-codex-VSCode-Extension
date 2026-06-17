import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import {
  buildDirectSessionArgs,
  captureTmuxPaneTail,
  findDangerousLaunchArgs,
  launchDirectSession,
  launchRequiresDangerousApproval,
  listTmuxPanes,
  readControlCenterSnapshot,
  readLogExplorerSnapshot,
  readWorkspaceSnapshot,
  redactOmxLogLine,
  resolveVscodeLaunchEnv,
  searchOmxLogs,
  sendTmuxPaneInput,
} from '../index.js';

function fakeChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough() as ChildProcess['stdout'];
  child.stderr = new PassThrough() as ChildProcess['stderr'];
  Object.defineProperty(child, 'pid', { value: 12345 });
  child.kill = (() => true) as ChildProcess['kill'];
  return child;
}

async function withTempDir(test: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-vscode-api-'));
  try {
    await test(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('VSCode UI-facing API', () => {
  it('builds direct launch args without preserving conflicting tmux policy flags', () => {
    assert.deepEqual(
      buildDirectSessionArgs({ codexArgs: ['--tmux', '--model', 'gpt-5', '--direct'] }),
      ['launch', '--direct', '--model', 'gpt-5'],
    );
    assert.deepEqual(
      buildDirectSessionArgs({ mode: 'resume', codexArgs: ['--tmux', '--last'] }),
      ['resume', '--direct', '--last'],
    );
  });

  it('requires explicit approval for dangerous launch flags', () => {
    const args = buildDirectSessionArgs({ codexArgs: ['--madmax', '--yolo'] });
    assert.equal(launchRequiresDangerousApproval(args), true);
    assert.deepEqual(findDangerousLaunchArgs(args), ['--madmax', '--yolo']);
    assert.throws(
      () => launchDirectSession({
        cwd: process.cwd(),
        codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        sessionId: 'test-danger',
      }),
      /dangerous_launch_requires_approval/,
    );
  });

  it('spawns omx in direct mode with VSCode session environment and log path', async () => {
    await withTempDir(async (cwd) => {
      let capturedCommand = '';
      let capturedArgs: string[] = [];
      let capturedOptions: SpawnOptions | undefined;
      const child = fakeChildProcess();
      const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
        capturedCommand = command;
        capturedArgs = [...args];
        capturedOptions = options;
        return child;
      };

      const handle = launchDirectSession({
        cwd,
        omxCommand: 'custom-omx',
        prompt: 'ship the extension',
        sessionId: 'vscode-test-session',
        env: { PATH: '/bin' },
      }, {
        spawn,
        now: () => new Date('2026-06-13T00:00:00.000Z'),
      });

      assert.equal(capturedCommand, 'custom-omx');
      assert.deepEqual(capturedArgs, ['launch', '--direct', 'ship the extension']);
      assert.equal(capturedOptions?.cwd, cwd);
      assert.equal((capturedOptions?.env as NodeJS.ProcessEnv).OMX_LAUNCH_POLICY, 'direct');
      assert.equal((capturedOptions?.env as NodeJS.ProcessEnv).OMX_VSCODE_SESSION_ID, 'vscode-test-session');
      assert.equal(handle.pid, 12345);
      assert.equal(handle.stop(), true);

      child.emit('exit', 0, null);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  it('builds VSCode launch env through the shared platform command resolver', async () => {
    await withTempDir(async (cwd) => {
      const binDir = join(cwd, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'codex'), '#!/bin/sh\n');

      const resolution = resolveVscodeLaunchEnv({
        cwd,
        omxCommand: join(cwd, 'dist', 'cli', 'omx.js'),
        baseEnv: { PATH: '' },
        extraPath: [binDir],
        platform: 'linux',
      });

      assert.equal(resolution.codexPath, join(binDir, 'codex'));
      assert.equal(resolution.env.PATH?.split(':')[0], binDir);
      assert.ok(resolution.pathEntries.includes(join(cwd, 'dist', 'cli')));
      assert.ok(resolution.pathEntries.includes(join(cwd, 'node_modules', '.bin')));
    });
  });

  it('redacts common auth material before writing UI logs', () => {
    const redacted = redactOmxLogLine('Authorization: Bearer sk-1234567890 and access_token=secret-token');
    assert.doesNotMatch(redacted, /sk-1234567890/);
    assert.doesNotMatch(redacted, /secret-token/);
    assert.match(redacted, /\[REDACTED]/);
  });

  it('reads workspace snapshots from file-backed OMX state', async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, '.omx', 'logs', 'vscode'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'state', 'team', 'demo'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'logs', 'vscode', 'vscode-test.log'), 'hello\n');

      const snapshot = await readWorkspaceSnapshot({
        cwd,
        now: new Date('2026-06-13T00:00:00.000Z'),
      });

      assert.equal(snapshot.schema_version, 'omx.vscode/workspace/v1');
      assert.equal(snapshot.cwd, cwd);
      assert.equal(snapshot.generated_at, '2026-06-13T00:00:00.000Z');
      assert.ok(snapshot.logs.some((log) => log.name === 'vscode-test.log'));
      assert.ok(snapshot.teams.some((team) => team.name === 'demo'));
      assert.equal(typeof snapshot.hud_text, 'string');
    });
  });

  it('builds control center snapshots without requiring tmux', async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state', 'team', 'demo'), { recursive: true });

      const snapshot = await readControlCenterSnapshot({
        cwd,
        now: new Date('2026-06-13T00:00:00.000Z'),
      });

      assert.equal(snapshot.schema_version, 'omx.vscode/control-center/v1');
      assert.equal(snapshot.workspace.cwd, cwd);
      assert.ok(snapshot.teams.some((team) => team.name === 'demo'));
      assert.equal(typeof snapshot.tmux.available, 'boolean');
    });
  });

  it('searches OMX logs with structured filters', async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'state', 'team', 'demo', 'events'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'logs', 'session-history.jsonl'),
        '{"session_id":"omx-session-1","started_at":"2026-06-13T00:00:00.000Z","message":"started"}\n',
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'demo', 'events', 'events.ndjson'),
        '{"event_id":"1","team":"demo","type":"worker_state_changed","worker":"worker-1","task_id":"7","created_at":"2026-06-13T00:01:00.000Z","message":"worker made progress"}\n',
      );

      const snapshot = await readLogExplorerSnapshot({ cwd, now: new Date('2026-06-13T00:02:00.000Z') });
      assert.equal(snapshot.schema_version, 'omx.vscode/log-explorer/v1');
      assert.ok(snapshot.logs.some((log) => log.source === 'team-events'));

      const results = await searchOmxLogs({ cwd, team: 'demo', worker: 'worker-1', query: 'progress' });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.task_id, '7');
      assert.equal(results[0]?.source, 'team-events');
    });
  });

  it('uses tmux wrappers through PATH-resolved tmux', async () => {
    await withTempDir(async (cwd) => {
      const binDir = join(cwd, 'bin');
      const logPath = join(cwd, 'tmux.log');
      await mkdir(binDir, { recursive: true });
      const tmuxPath = join(binDir, 'tmux');
      await writeFile(tmuxPath, [
        '#!/bin/sh',
        'if [ "$1" = "list-panes" ]; then',
        '  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "%1" "omx-team" "0" "1" "leader" "codex" "1"',
        '  exit 0',
        'fi',
        'if [ "$1" = "capture-pane" ]; then',
        '  printf "tail line\\n"',
        '  exit 0',
        'fi',
        'if [ "$1" = "send-keys" ]; then',
        `  echo "$@" >> "${logPath}"`,
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'));
      await chmod(tmuxPath, 0o755);

      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
      try {
        const panes = listTmuxPanes();
        assert.equal(panes[0]?.id, '%1');
        assert.equal(panes[0]?.session, 'omx-team');

        const tail = captureTmuxPaneTail({ target: '%1', lines: 40 });
        assert.match(tail.body, /tail line/);

        const sent = sendTmuxPaneInput({ target: '%1', text: 'continue work', submit: true });
        assert.equal(sent.target, '%1');
        assert.equal(sent.submitted, true);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});

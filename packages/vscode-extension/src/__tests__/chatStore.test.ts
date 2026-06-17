import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createConversation,
  listConversations,
  readConversation,
} from '../chatStore';

async function withTempDir(test: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-vscode-chat-store-'));
  try {
    await test(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function conversationFile(cwd: string, id: string): string {
  return join(cwd, '.omx', 'vscode', 'conversations', `${id}.json`);
}

describe('VSCode chat store', () => {
  it('skips malformed conversation JSON instead of breaking the webview state', async () => {
    await withTempDir(async (cwd) => {
      const valid = await createConversation(cwd, 'valid conversation');
      await mkdir(join(cwd, '.omx', 'vscode', 'conversations'), { recursive: true });
      await writeFile(
        conversationFile(cwd, 'chat-broken'),
        '{"schema_version":"omx.vscode/conversation/v1","id":"chat-broken","messages":[{"text":"unterminated',
      );

      assert.equal(await readConversation(cwd, 'chat-broken'), null);
      assert.equal((await readConversation(cwd, valid.id))?.title, 'valid conversation');

      const conversations = await listConversations(cwd);
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0]?.id, valid.id);
      assert.equal(conversations[0]?.message_count, 0);
    });
  });
});

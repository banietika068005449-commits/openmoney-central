import { after, beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { pool } from '../db.js';
import { ensureAgentSchema } from './agentSchema.repo.js';
import {
  countOpenChatUnreadForAgent,
  createOpenChatMessage,
  listOpenChatConversations,
  listOpenChatMessages,
  markOpenChatRead,
} from './agentChat.repo.js';

const TEST_PHONE_PREFIX = '+99OPENCHAT';

async function cleanup() {
  await pool.query(`DELETE FROM agent WHERE phone LIKE $1`, [`${TEST_PHONE_PREFIX}%`]);
}

async function insertAgent(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO agent (name, city, phone, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id, name, phone`,
    [`Agent Chat ${suffix}`, 'Brazzaville', `${TEST_PHONE_PREFIX}${suffix}`],
  );
  return rows[0];
}

beforeEach(async () => {
  await ensureAgentSchema();
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test('OpenChat: messages 1:1, unread agent/admin et read markers', async () => {
  const agent = await insertAgent(Date.now());

  const adminMessage = await createOpenChatMessage(agent.id, 'admin', 'Bonjour agent');
  const agentMessage = await createOpenChatMessage(agent.id, 'agent', 'Bonjour admin');

  assert.equal(adminMessage.sender_type, 'admin');
  assert.equal(agentMessage.sender_type, 'agent');

  const all = await listOpenChatMessages(agent.id, { limit: 10 });
  assert.deepEqual(all.map((m) => m.body), ['Bonjour agent', 'Bonjour admin']);

  const afterFirst = await listOpenChatMessages(agent.id, { after: adminMessage.id, limit: 10 });
  assert.deepEqual(afterFirst.map((m) => m.body), ['Bonjour admin']);

  assert.equal(await countOpenChatUnreadForAgent(agent.id), 1);
  await markOpenChatRead(agent.id, 'agent');
  assert.equal(await countOpenChatUnreadForAgent(agent.id), 0);

  const conversationsBeforeAdminRead = await listOpenChatConversations();
  const convoBefore = conversationsBeforeAdminRead.find((item) => Number(item.id) === Number(agent.id));
  assert.equal(convoBefore.unread_count, 1);

  await markOpenChatRead(agent.id, 'admin');
  const conversationsAfterAdminRead = await listOpenChatConversations();
  const convoAfter = conversationsAfterAdminRead.find((item) => Number(item.id) === Number(agent.id));
  assert.equal(convoAfter.unread_count, 0);
  assert.equal(convoAfter.last_message_body, 'Bonjour admin');
});

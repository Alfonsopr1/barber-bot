const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

function createFakeSupabase({ messageLogsShouldFail }) {
  const webhookEvents = new Map();

  return {
    webhookEvents,
    client: {
      from(table) {
        if (table === 'webhook_events') {
          return {
            insert: async (row) => {
              if (webhookEvents.has(row.meta_event_id)) {
                return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
              }
              webhookEvents.set(row.meta_event_id, { processed_at: null });
              return { error: null };
            },
            select: () => ({
              eq: (_column, value) => ({
                maybeSingle: async () => {
                  const row = webhookEvents.get(value);
                  return { data: row ? { processed_at: row.processed_at } : null, error: null };
                },
              }),
            }),
            update: (fields) => ({
              eq: async (_column, value) => {
                const row = webhookEvents.get(value);
                if (row) row.processed_at = fields.processed_at;
                return { error: null };
              },
            }),
          };
        }

        if (table === 'shops') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: 'shop-123', is_active: true }, error: null }),
                }),
              }),
            }),
          };
        }

        if (table === 'message_logs') {
          return {
            insert: async () => {
              if (messageLogsShouldFail.value) throw new Error('simulated transient failure');
              return { error: null };
            },
          };
        }

        throw new Error(`Unexpected table in test: ${table}`);
      },
    },
  };
}

test('a half-failed event can be retried, and a fully processed event never sends a second reply', async (t) => {
  const messageLogsShouldFail = { value: false };
  const { webhookEvents, client: fakeSupabase } = createFakeSupabase({ messageLogsShouldFail });
  let sendCount = 0;

  const supabaseMock = mock.module('../db/supabaseClient.js', { defaultExport: fakeSupabase });
  const whatsappMock = mock.module('../utils/whatsapp.js', {
    namedExports: {
      sendTextMessage: async () => {
        sendCount += 1;
      },
    },
  });
  t.after(() => {
    supabaseMock.restore();
    whatsappMock.restore();
  });

  const { handleIncomingMessage } = require('./webhookHandler');

  // A transient failure (e.g. a dropped DB connection) before the reply is
  // sent must leave the event reprocessable, not silently stuck forever.
  const partialMessage = { id: 'wamid-partial-1', from: '10000000000', type: 'text', text: { body: 'hi' } };

  messageLogsShouldFail.value = true;
  await assert.rejects(() => handleIncomingMessage('phone-id', partialMessage));
  assert.strictEqual(webhookEvents.get('wamid-partial-1').processed_at, null, 'a failed attempt must stay unprocessed');
  assert.strictEqual(sendCount, 0, 'no reply should go out when the attempt fails before that step');

  messageLogsShouldFail.value = false;
  await handleIncomingMessage('phone-id', partialMessage); // Meta retries the same event
  assert.strictEqual(sendCount, 1, 'the retried attempt should succeed and send exactly one reply');
  assert.ok(webhookEvents.get('wamid-partial-1').processed_at, 'a successful attempt must be marked processed');

  // Once an event is fully processed, redelivering it must never send a
  // second reply.
  const doneMessage = { id: 'wamid-done-1', from: '10000000001', type: 'text', text: { body: 'hi again' } };

  await handleIncomingMessage('phone-id', doneMessage);
  assert.strictEqual(sendCount, 2);

  await handleIncomingMessage('phone-id', doneMessage); // Meta redelivers the same event
  assert.strictEqual(sendCount, 2, 'a retry of an already-processed event must not send a second reply');
});

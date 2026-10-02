const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

test('the outbound reply gets logged, and a failure to log it never blocks or duplicates the send', async (t) => {
  const messageLogInserts = [];
  let sendCount = 0;
  let outboundLogShouldFail = false;

  const fakeSupabase = {
    from(table) {
      if (table === 'webhook_events') {
        return {
          insert: async () => ({ error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
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
          insert: async (row) => {
            if (row.direction === 'outbound' && outboundLogShouldFail) {
              return { error: { message: 'simulated insert failure' } };
            }
            messageLogInserts.push(row);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table in test: ${table}`);
    },
  };

  const supabaseMock = mock.module('../db/supabaseClient.js', { defaultExport: fakeSupabase });
  const whatsappMock = mock.module('../utils/whatsapp.js', {
    namedExports: {
      sendTextMessage: async () => {
        sendCount += 1;
        return { messages: [{ id: 'wamid.outbound-test-1' }] };
      },
    },
  });
  t.after(() => {
    supabaseMock.restore();
    whatsappMock.restore();
  });

  const { handleIncomingMessage } = require('./webhookHandler');

  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errorLogs.push(args);
  t.after(() => {
    console.error = originalConsoleError;
  });

  // 1) Normal case: the reply gets logged as an outbound message_logs row.
  await handleIncomingMessage('phone-id', {
    id: 'wamid-in-1',
    from: '10000000000',
    type: 'text',
    text: { body: 'hi' },
  });

  const outboundRow = messageLogInserts.find((row) => row.direction === 'outbound');
  assert.ok(outboundRow, 'expected an outbound row in message_logs');
  assert.strictEqual(outboundRow.shop_id, 'shop-123');
  assert.strictEqual(outboundRow.meta_message_id, 'wamid.outbound-test-1');
  assert.strictEqual(sendCount, 1);

  // 2) The outbound log write fails: the send must still have happened
  // exactly once (no duplicate retry), and the failure must be logged
  // with shopId + error message, never a phone number.
  outboundLogShouldFail = true;
  await handleIncomingMessage('phone-id', {
    id: 'wamid-in-2',
    from: '10000000001',
    type: 'text',
    text: { body: 'hi again' },
  });

  assert.strictEqual(sendCount, 2, 'the send must still happen even if logging it fails');

  const logFailureEntry = errorLogs.find(([msg]) => msg === 'Error logging outbound WhatsApp message');
  assert.ok(logFailureEntry, 'expected a logged failure for the outbound message_logs insert');
  assert.strictEqual(logFailureEntry[1].shopId, 'shop-123');
  assert.strictEqual(logFailureEntry[1].errorMessage, 'simulated insert failure');

  const serializedLogs = JSON.stringify(errorLogs);
  assert.ok(!serializedLogs.includes('10000000001'), 'must never log the client phone number');
});

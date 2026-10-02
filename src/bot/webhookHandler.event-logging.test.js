const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');

const TEST_APP_SECRET = 'test-secret-for-event-logging';
process.env.WHATSAPP_APP_SECRET = TEST_APP_SECRET;

function sign(body) {
  return `sha256=${crypto.createHmac('sha256', TEST_APP_SECRET).update(body).digest('hex')}`;
}

function buildRequest(payload) {
  const body = JSON.stringify(payload);
  return {
    rawBody: Buffer.from(body),
    body: payload,
    get: (header) => (header.toLowerCase() === 'x-hub-signature-256' ? sign(body) : undefined),
  };
}

test('one log line per webhook POST: event type, item count, shop match — never phone/text/names', async (t) => {
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
            eq: (_column, phoneNumberId) => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: phoneNumberId === 'phone-with-shop' ? { id: 'shop-123', is_active: true } : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'message_logs') {
        return {
          insert: async () => ({ error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }

      throw new Error(`Unexpected table in test: ${table}`);
    },
  };

  const supabaseMock = mock.module('../db/supabaseClient.js', { defaultExport: fakeSupabase });
  const whatsappMock = mock.module('../utils/whatsapp.js', { namedExports: { sendTextMessage: async () => {} } });
  t.after(() => {
    supabaseMock.restore();
    whatsappMock.restore();
  });

  const { receiveWebhook } = require('./webhookHandler');

  const logs = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => logs.push(args);
  t.after(() => {
    console.log = originalConsoleLog;
  });

  const res = { sendStatus: () => {} };
  const clientPhone = '5550001111';
  const clientMessageText = 'secreto del cliente';
  const contactName = 'alguien privado';

  // messages, shop found
  await receiveWebhook(
    buildRequest({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-with-shop' },
                messages: [{ id: 'm1', from: clientPhone, type: 'text', text: { body: clientMessageText } }],
              },
            },
          ],
        },
      ],
    }),
    res
  );

  // statuses, no matching shop
  await receiveWebhook(
    buildRequest({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-without-shop' },
                statuses: [{ id: 's1', status: 'delivered' }, { id: 's2', status: 'read' }],
              },
            },
          ],
        },
      ],
    }),
    res
  );

  // neither messages nor statuses ("other")
  await receiveWebhook(
    buildRequest({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-with-shop' },
                contacts: [{ profile: { name: contactName } }],
              },
            },
          ],
        },
      ],
    }),
    res
  );

  const eventLogs = logs.filter(([message]) => message === 'Webhook event received');
  assert.strictEqual(eventLogs.length, 3, 'expected exactly one event-summary log line per POST');

  assert.deepStrictEqual(eventLogs[0][1], { eventType: 'messages', itemCount: 1, matchesShop: true });
  assert.deepStrictEqual(eventLogs[1][1], { eventType: 'statuses', itemCount: 2, matchesShop: false });
  assert.deepStrictEqual(eventLogs[2][1], { eventType: 'other', itemCount: 0, matchesShop: true });

  const serializedLogs = JSON.stringify(logs);
  assert.ok(!serializedLogs.includes(clientPhone), 'must never log a phone number');
  assert.ok(!serializedLogs.includes(clientMessageText), 'must never log message text');
  assert.ok(!serializedLogs.includes(contactName), 'must never log a contact/profile name');
});

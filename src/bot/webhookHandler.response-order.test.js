const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');

// webhookHandler.js reads WHATSAPP_APP_SECRET into a module-level const at
// require() time, so this must be set before the module is first required.
const TEST_APP_SECRET = 'test-secret-for-ordering';
process.env.WHATSAPP_APP_SECRET = TEST_APP_SECRET;

test('receiveWebhook only responds after the event has been fully processed', async (t) => {
  const order = [];

  const fakeSupabase = {
    from(table) {
      if (table === 'webhook_events') {
        return {
          insert: async () => {
            order.push('insert-webhook-event');
            return { error: null };
          },
          update: () => ({
            eq: async () => {
              order.push('mark-processed');
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
                // No shop configured for this test's phone_number_id — the
                // handler still has to finish (and mark the event
                // processed) before responding.
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
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

  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'phone-id-with-no-shop' },
              messages: [{ id: 'wamid-order-1', from: '10000000002', type: 'text', text: { body: 'hi' } }],
            },
          },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', TEST_APP_SECRET).update(body).digest('hex')}`;

  const req = {
    rawBody: Buffer.from(body),
    body: payload,
    get: (header) => (header.toLowerCase() === 'x-hub-signature-256' ? signature : undefined),
  };
  const res = {
    sendStatus: (code) => order.push(`respond-${code}`),
  };

  await receiveWebhook(req, res);

  assert.deepStrictEqual(order, ['insert-webhook-event', 'mark-processed', 'respond-200']);
});

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

test('handleIncomingMessage logs Meta error details but never the client phone or message text when the reply fails to send', async () => {
  const fakeSupabase = {
    from() {
      return {
        insert: async () => ({ error: null }),
        update() {
          return { eq: async () => ({ error: null }) };
        },
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: { id: 'shop-123', is_active: true }, error: null }),
      };
    },
  };

  const sendError = new Error('Session has expired');
  sendError.httpStatus = 401;
  sendError.metaErrorCode = 190;

  mock.module('../db/supabaseClient.js', { defaultExport: fakeSupabase });
  mock.module('../utils/whatsapp.js', {
    namedExports: {
      sendTextMessage: async () => {
        throw sendError;
      },
    },
  });

  const { handleIncomingMessage } = require('./webhookHandler');

  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errorLogs.push(args);

  const clientPhone = '5550001234';
  const clientMessageText = 'this is a private message from the client';

  try {
    await handleIncomingMessage('phone-number-id-test', {
      id: `wamid-test-${Date.now()}`,
      from: clientPhone,
      type: 'text',
      text: { body: clientMessageText },
    });
  } finally {
    console.error = originalConsoleError;
  }

  const replyErrorLog = errorLogs.find(([message]) => message === 'Error sending WhatsApp reply');
  assert.ok(replyErrorLog, 'expected an "Error sending WhatsApp reply" log entry');

  const [, details] = replyErrorLog;
  assert.strictEqual(details.shopId, 'shop-123');
  assert.strictEqual(details.httpStatus, 401);
  assert.strictEqual(details.metaErrorCode, 190);
  assert.strictEqual(details.errorMessage, 'Session has expired');

  const serializedLog = JSON.stringify(errorLogs);
  assert.ok(!serializedLog.includes(clientPhone), 'must never log the client phone number');
  assert.ok(!serializedLog.includes(clientMessageText), 'must never log the message text');
});

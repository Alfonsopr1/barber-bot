const test = require('node:test');
const assert = require('node:assert');

const { sendTextMessage } = require('./whatsapp');

test('sendTextMessage throws a structured error with Meta httpStatus and error code', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Session has expired', code: 190 } }), {
      status: 401,
    });

  try {
    await assert.rejects(
      () => sendTextMessage('phone-number-id', 'client-phone', 'hello'),
      (err) => {
        assert.strictEqual(err.message, 'Session has expired');
        assert.strictEqual(err.httpStatus, 401);
        assert.strictEqual(err.metaErrorCode, 190);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

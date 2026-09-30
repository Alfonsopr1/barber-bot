const crypto = require('crypto');

// Verifies Meta's X-Hub-Signature-256 header against the raw request body,
// using the WhatsApp app secret. Must run before the body is trusted.
function isValidSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !rawBody) return false;

  const expectedSignature = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.replace('sha256=', '');

  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = { isValidSignature };

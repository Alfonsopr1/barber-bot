const supabase = require('../db/supabaseClient');
const { isValidSignature } = require('../utils/verifySignature');
const { sendTextMessage } = require('../utils/whatsapp');
const messages = require('../config/messages');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

const UNIQUE_VIOLATION = '23505';

// Meta calls this once, at setup time, to confirm we own the endpoint.
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}

async function receiveWebhook(req, res) {
  const signature = req.get('x-hub-signature-256');

  if (!isValidSignature(req.rawBody, signature, APP_SECRET)) {
    return res.sendStatus(401);
  }

  // Ack fast: Meta retries the whole payload if it doesn't see a quick 200.
  res.sendStatus(200);

  try {
    await processWebhookBody(req.body);
  } catch (err) {
    console.error('Error processing webhook event', err);
  }
}

async function processWebhookBody(body) {
  const entries = body.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata && value.metadata.phone_number_id;

      for (const message of value.messages || []) {
        await handleIncomingMessage(phoneNumberId, message);
      }

      for (const status of value.statuses || []) {
        await handleStatusUpdate(status);
      }
    }
  }
}

async function handleIncomingMessage(phoneNumberId, message) {
  const isNew = await recordWebhookEvent(message.id, 'message', message);
  if (!isNew) return;

  const shop = await findShopByPhoneNumberId(phoneNumberId);
  if (!shop) {
    console.error(`No shop found for phone_number_id ${phoneNumberId}`);
    return;
  }

  await supabase.from('message_logs').insert({
    shop_id: shop.id,
    client_phone: message.from,
    direction: 'inbound',
    message_type: message.type,
    content: message,
    meta_message_id: message.id,
  });

  try {
    await sendTextMessage(phoneNumberId, message.from, messages.GENERIC_WELCOME);
  } catch (err) {
    console.error('Error sending WhatsApp reply', {
      shopId: shop.id,
      httpStatus: err.httpStatus,
      metaErrorCode: err.metaErrorCode,
      errorMessage: err.message,
    });
  }
}

async function handleStatusUpdate(status) {
  const isNew = await recordWebhookEvent(status.id, 'status', status);
  if (!isNew) return;

  await supabase.from('message_logs').update({ status: status.status }).eq('meta_message_id', status.id);
}

// Returns false if this event was already processed (Meta redelivered it).
async function recordWebhookEvent(metaEventId, eventType, payload) {
  if (!metaEventId) return true;

  const { error } = await supabase.from('webhook_events').insert({
    meta_event_id: metaEventId,
    event_type: eventType,
    payload,
    processed_at: new Date().toISOString(),
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return false;
    throw error;
  }

  return true;
}

async function findShopByPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

module.exports = { verifyWebhook, receiveWebhook, handleIncomingMessage };

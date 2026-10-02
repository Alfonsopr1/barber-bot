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

  // Finish the work before acking: on Vercel the function can be frozen
  // right after the response is sent, so anything scheduled to run after
  // res.sendStatus(200) is not guaranteed to actually execute.
  try {
    await processWebhookBody(req.body);
  } catch (err) {
    console.error('Error processing webhook event', err);
  }

  res.sendStatus(200);
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
  const shouldProcess = await claimWebhookEvent(message.id, 'message', message);
  if (!shouldProcess) return;

  const shop = await findShopByPhoneNumberId(phoneNumberId);
  if (!shop) {
    console.error(`No shop found for phone_number_id ${phoneNumberId}`);
    await markWebhookEventProcessed(message.id);
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

  await markWebhookEventProcessed(message.id);
}

async function handleStatusUpdate(status) {
  const shouldProcess = await claimWebhookEvent(status.id, 'status', status);
  if (!shouldProcess) return;

  await supabase.from('message_logs').update({ status: status.status }).eq('meta_message_id', status.id);

  await markWebhookEventProcessed(status.id);
}

// Claims an event for processing. Returns false only if a previous attempt
// already finished it (so a Meta redelivery never triggers a second reply).
// If a previous attempt inserted the row but crashed before calling
// markWebhookEventProcessed, this returns true so it gets retried instead
// of being silently dropped.
async function claimWebhookEvent(metaEventId, eventType, payload) {
  if (!metaEventId) return true;

  const { error } = await supabase.from('webhook_events').insert({
    meta_event_id: metaEventId,
    event_type: eventType,
    payload,
  });

  if (!error) return true;
  if (error.code !== UNIQUE_VIOLATION) throw error;

  const { data, error: selectError } = await supabase
    .from('webhook_events')
    .select('processed_at')
    .eq('meta_event_id', metaEventId)
    .maybeSingle();

  if (selectError) throw selectError;

  return !data || !data.processed_at;
}

async function markWebhookEventProcessed(metaEventId) {
  if (!metaEventId) return;

  const { error } = await supabase
    .from('webhook_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('meta_event_id', metaEventId);

  if (error) throw error;
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

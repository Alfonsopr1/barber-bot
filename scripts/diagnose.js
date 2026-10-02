#!/usr/bin/env node
// Read-only webhook diagnostics. Loads .env.local/.env itself and never
// prints secret values — only OK/FALLO plus a short, non-sensitive reason.
//
// Usage:
//   node scripts/diagnose.js <production-url> <waba-id>
//
// <production-url> is needed for checks 4 and 5 (they call your real
// production webhook). <waba-id> is needed for check 6 (Meta's WhatsApp
// Business Account id, from Meta for Developers).
//
// Heads up: check 5 sends a signed test event to your real production
// webhook. If the signature passes, it inserts one throwaway row into
// webhook_events (meta_event_id starting with "diagnose-script-"). It will
// NOT reach message_logs or send a WhatsApp reply, because the test uses a
// fake phone_number_id that won't match any real shop. See the end of this
// file for a cleanup query.

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WHATSAPP_TOKEN',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
];

const WHATSAPP_API_VERSION = 'v20.0';

function checkEnvVars() {
  return REQUIRED_VARS.map((name) => {
    const raw = process.env[name];

    if (raw === undefined) return { name, ok: false, reason: 'no está definida' };
    if (raw.length === 0) return { name, ok: false, reason: 'está vacía' };
    if (raw !== raw.trim()) return { name, ok: false, reason: 'tiene espacios al principio o al final' };
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return { name, ok: false, reason: 'tiene comillas incluidas en el valor' };
    }

    return { name, ok: true };
  });
}

async function checkSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return { ok: false, reason: 'faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' };
  }

  let createClient;
  try {
    ({ createClient } = require('@supabase/supabase-js'));
  } catch {
    return { ok: false, reason: 'no se encontró la dependencia @supabase/supabase-js (corre npm install)' };
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const counts = {};
  const countErrors = {};
  for (const table of ['shops', 'message_logs', 'webhook_events']) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) countErrors[table] = error.message;
    else counts[table] = count;
  }

  let phoneNumberIdDigitCounts;
  let phoneNumberIdError;
  const { data: shops, error: shopsError } = await supabase.from('shops').select('phone_number_id');
  if (shopsError) phoneNumberIdError = shopsError.message;
  else phoneNumberIdDigitCounts = shops.map((row) => (row.phone_number_id || '').replace(/\D/g, '').length);

  const ok = Object.keys(countErrors).length === 0 && !phoneNumberIdError;
  return { ok, counts, countErrors, phoneNumberIdDigitCounts, phoneNumberIdError };
}

async function checkWhatsAppToken() {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, reason: 'WHATSAPP_TOKEN no está definida' };

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;

  let res;
  let data;
  try {
    res = await fetch(url);
    data = await res.json();
  } catch {
    return { ok: false, reason: 'no se pudo conectar a la Graph API de Meta' };
  }

  if (data.error) {
    return { ok: false, httpStatus: res.status, metaError: data.error.message, metaErrorCode: data.error.code };
  }

  const info = data.data || {};
  return { ok: Boolean(info.is_valid), httpStatus: res.status, isValid: info.is_valid, expiresAt: info.expires_at };
}

async function checkWebhookVerification(productionUrl) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return { ok: false, reason: 'WHATSAPP_VERIFY_TOKEN no está definida' };
  if (!productionUrl) return { ok: false, reason: 'falta el argumento <production-url>' };

  const challenge = `diagnose-${Date.now()}`;
  const url = new URL('/webhook', productionUrl);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', verifyToken);
  url.searchParams.set('hub.challenge', challenge);

  let res;
  let body;
  try {
    res = await fetch(url.toString());
    body = await res.text();
  } catch {
    return { ok: false, reason: 'no se pudo conectar a la URL de producción' };
  }

  return { ok: res.status === 200 && body === challenge, httpStatus: res.status };
}

async function checkWebhookSignature(productionUrl) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return { ok: false, reason: 'WHATSAPP_APP_SECRET no está definida' };
  if (!productionUrl) return { ok: false, reason: 'falta el argumento <production-url>' };

  const testEventId = `diagnose-script-${Date.now()}`;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'diagnose-script',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'diagnose-script-phone-number-id' },
              messages: [
                {
                  id: testEventId,
                  from: '10000000000',
                  type: 'text',
                  text: { body: 'diagnose script test' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(body).digest('hex')}`;
  const url = new URL('/webhook', productionUrl);

  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
      body,
    });
  } catch {
    return { ok: false, reason: 'no se pudo conectar a la URL de producción' };
  }

  return { ok: res.status === 200, httpStatus: res.status, testEventId };
}

async function checkSubscribedApps(wabaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, reason: 'WHATSAPP_TOKEN no está definida' };
  if (!wabaId) return { ok: false, reason: 'falta el argumento <waba-id>' };

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(wabaId)}/subscribed_apps?access_token=${encodeURIComponent(token)}`;

  let res;
  let data;
  try {
    res = await fetch(url);
    data = await res.json();
  } catch {
    return { ok: false, reason: 'no se pudo conectar a la Graph API de Meta' };
  }

  if (data.error) {
    return { ok: false, httpStatus: res.status, metaError: data.error.message, metaErrorCode: data.error.code };
  }

  const apps = data.data || [];
  return { ok: apps.length > 0, httpStatus: res.status, subscribedAppsCount: apps.length };
}

function printCheck(title, result) {
  const status = result.ok ? 'OK' : 'FALLO';
  console.log(`\n${title}: ${status}`);

  const { ok, ...rest } = result;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    console.log(`  - ${key}: ${JSON.stringify(value)}`);
  }
}

async function main() {
  const [productionUrl, wabaId] = process.argv.slice(2);

  console.log('=== 1) Variables de entorno ===');
  for (const result of checkEnvVars()) {
    console.log(`${result.name}: ${result.ok ? 'OK' : `FALLO: ${result.reason}`}`);
  }

  printCheck('=== 2) Conexión a Supabase ===', await checkSupabase());
  printCheck('=== 3) Token de WhatsApp (debug_token) ===', await checkWhatsAppToken());
  printCheck('=== 4) Verificación del webhook (GET) ===', await checkWebhookVerification(productionUrl));
  printCheck('=== 5) Firma del webhook (POST firmado) ===', await checkWebhookSignature(productionUrl));
  printCheck('=== 6) Suscripción de la app al WABA ===', await checkSubscribedApps(wabaId));

  console.log('\nListo. Ningún valor secreto fue impreso por este script.');
}

main().catch((err) => {
  console.error('El script falló de forma inesperada:', err.message);
  process.exit(1);
});

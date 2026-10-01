const { WHATSAPP_API_VERSION } = require('../config/constants');

const token = process.env.WHATSAPP_TOKEN;

async function sendTextMessage(phoneNumberId, to, body) {
  return callWhatsAppApi(phoneNumberId, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

async function sendTemplateMessage(phoneNumberId, to, templateName, languageCode, components) {
  return callWhatsAppApi(phoneNumberId, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  });
}

async function callWhatsAppApi(phoneNumberId, body) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`WhatsApp API error: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = { sendTextMessage, sendTemplateMessage };

'use strict';

const axios = require('axios');

// ─── DB-aware Setting Reader ──────────────────────────────────────────────────
// يجيب القيمة من قاعدة البيانات (اللي تم حفظه من الإعدادات) أو يفول باك على process.env

async function getSetting(key) {
  try {
    const { getSetting: dbGet } = require('../database/db');
    const val = await dbGet(key);
    if (val !== null && val !== undefined && val !== '') return val;
  } catch {}
  return process.env[key] || '';
}

// ─── Provider Detection (DB-first) ───────────────────────────────────────────

async function getProvider() {
  const provider = await getSetting('WHATSAPP_PROVIDER');
  return (provider || 'internal').toLowerCase();
}

// ─── Phone Normalization ──────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^01\d{9}$/.test(p)) p = '20' + p.slice(1);
  if (p.length < 10) return null;
  return p; // plain digits e.g. 201012345678
}

function normalizePhoneToWhatsApp(phone) {
  const p = normalizePhone(phone);
  return p ? `${p}@c.us` : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GREEN API
// ═══════════════════════════════════════════════════════════════════════════════

async function greenBase() {
  const id = await getSetting('GREEN_API_INSTANCE_ID');
  return `https://api.green-api.com/waInstance${id}`;
}
async function greenToken() {
  return getSetting('GREEN_API_TOKEN');
}

async function greenSendMessage(phone, message) {
  const chatId = normalizePhoneToWhatsApp(phone);
  if (!chatId) return { success: false, error: `Cannot normalize phone: ${phone}` };
  try {
    const base = await greenBase();
    const token = await greenToken();
    const res = await axios.post(`${base}/sendMessage/${token}`, { chatId, message }, { timeout: 15000 });
    return { success: true, chatId, data: res.data };
  } catch (err) {
    const e = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    console.error(`[Green] Failed to send to ${chatId}:`, e);
    return { success: false, chatId, error: e };
  }
}

async function greenSendPoll(phone, message, options) {
  const chatId = normalizePhoneToWhatsApp(phone);
  if (!chatId) return { success: false, error: `Cannot normalize phone: ${phone}` };
  try {
    const base = await greenBase();
    const token = await greenToken();
    const res = await axios.post(`${base}/sendPoll/${token}`, { chatId, message, options, multipleAnswers: false }, { timeout: 15000 });
    return { success: true, chatId, data: res.data };
  } catch (err) {
    const e = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    console.error(`[Green] Failed Poll to ${chatId}:`, e);
    return { success: false, chatId, error: e };
  }
}

async function greenRegisterWebhook(webhookUrl) {
  try {
    const base = await greenBase();
    const token = await greenToken();
    const res = await axios.post(`${base}/setSettings/${token}`, {
      incomingWebhook: 'yes', webhookUrl,
      outgoingWebhook: 'no', stateWebhook: 'no',
      receiveNotificationsOther: 'no', pollMessageWebhook: 'yes',
    }, { timeout: 10000 });
    return { success: true, data: res.data };
  } catch (err) {
    const e = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    return { success: false, error: e };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// META (WhatsApp Cloud API)
// ═══════════════════════════════════════════════════════════════════════════════

async function metaPhoneId() { return getSetting('META_PHONE_NUMBER_ID'); }
async function metaToken()   { return getSetting('META_ACCESS_TOKEN'); }

async function metaSendMessage(phone, message) {
  const to = normalizePhone(phone);
  if (!to) return { success: false, error: `Cannot normalize phone: ${phone}` };
  try {
    const phoneId = await metaPhoneId();
    const token   = await metaToken();
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    console.log(`[Meta] Message sent to ${to}:`, res.data);
    return { success: true, chatId: to, data: res.data };
  } catch (err) {
    const e = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    console.error(`[Meta] Failed to send to ${to}:`, e);
    return { success: false, chatId: to, error: e };
  }
}

// Meta مش بيدعم Polls — بنبعت رسالة نصية بدلها مع الخيارات مكتوبة
async function metaSendPoll(phone, message, options) {
  const to = normalizePhone(phone);
  if (!to) return { success: false, error: `Cannot normalize phone: ${phone}` };

  const optionsText = options.map((o, i) => `${i + 1}. ${o.optionName}`).join('\n');
  const fullMessage = `${message}\n\n${optionsText}`;

  try {
    const phoneId = await metaPhoneId();
    const token   = await metaToken();
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: fullMessage },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    console.log(`[Meta] Poll-text sent to ${to}:`, res.data);
    return { success: true, chatId: to, data: res.data };
  } catch (err) {
    const e = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    console.error(`[Meta] Failed poll-text to ${to}:`, e);
    return { success: false, chatId: to, error: e };
  }
}

async function metaRegisterWebhook() {
  console.log('[Meta] Webhook must be configured in Meta Developer Console (not via API).');
  return { success: true, note: 'Meta webhook configured via console' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED API — الكود التاني كله بيستخدم الدوال دي بس
// ═══════════════════════════════════════════════════════════════════════════════

const baileysClient = require('./baileys_client');

// ─── Internal Baileys: استنى الاتصال يتم قبل الإرسال ────────────────────────
// بيستنى لحد BAILEYS_CONNECT_TIMEOUT_MS (default 20 ثانية)
// لو ما اتصلش في الوقت ده بيرجع error بدل ما يفشل بصمت

const BAILEYS_CONNECT_TIMEOUT_MS = parseInt(process.env.BAILEYS_CONNECT_TIMEOUT_MS || '20000', 10);

async function ensureBaileysConnected() {
  const status = baileysClient.getConnectionStatus();
  if (status.state === 'connected') return true;
  console.log(`[WhatsApp] Baileys not connected (state: ${status.state}) — waiting up to ${BAILEYS_CONNECT_TIMEOUT_MS / 1000}s...`);
  const connected = await baileysClient.waitUntilConnected(BAILEYS_CONNECT_TIMEOUT_MS);
  if (connected) {
    console.log('[WhatsApp] ✅ Baileys connected — proceeding to send.');
  } else {
    console.warn('[WhatsApp] ⚠️ Baileys did not connect within timeout — will attempt send anyway.');
  }
  return connected;
}

async function sendWhatsAppMessage(phone, message, withImage = false, imageKey = 'WHATSAPP_MESSAGE_IMAGE_BASE64', rawImageBase64 = null) {
  const provider = await getProvider();
  if (provider === 'meta') return metaSendMessage(phone, message);
  if (provider === 'green') return greenSendMessage(phone, message);

  // Default to Internal (Baileys)
  const p = normalizePhone(phone);
  if (!p) return { success: false, error: 'Invalid phone' };
  await ensureBaileysConnected();
  const res = await baileysClient.sendWhatsAppMessage(p, message, withImage, imageKey, rawImageBase64);
  return { success: res, chatId: p, data: {} };
}

async function sendWhatsAppMessageWithRetry(phone, message, withImage = false, imageKey = 'WHATSAPP_MESSAGE_IMAGE_BASE64', rawImageBase64 = null) {
  let result = await sendWhatsAppMessage(phone, message, withImage, imageKey, rawImageBase64);
  for (let attempt = 1; attempt <= 2 && !result.success; attempt++) {
    console.log(`[WhatsApp] Retrying in 5 seconds... (attempt ${attempt})`);
    await new Promise(r => setTimeout(r, 5000));
    result = await sendWhatsAppMessage(phone, message, withImage, imageKey, rawImageBase64);
  }
  return result;
}

async function sendPollMessage(phone, message, options) {
  const provider = await getProvider();
  if (provider === 'meta') return metaSendPoll(phone, message, options);
  if (provider === 'green') return greenSendPoll(phone, message, options);

  // Default to Internal (Baileys)
  const p = normalizePhone(phone);
  if (!p) return { success: false, error: 'Invalid phone' };
  await ensureBaileysConnected();
  const pollOptions = options.map(o => o.optionName);
  const res = await baileysClient.sendWhatsAppPoll(p, message, pollOptions);
  return { success: res, chatId: p, data: {} };
}

async function sendPollWithRetry(phone, message, options) {
  let result = await sendPollMessage(phone, message, options);
  for (let attempt = 1; attempt <= 2 && !result.success; attempt++) {
    console.log(`[WhatsApp] Retrying Poll in 5 seconds... (attempt ${attempt})`);
    await new Promise(r => setTimeout(r, 5000));
    result = await sendPollMessage(phone, message, options);
  }
  return result;
}

async function registerWebhook(webhookUrl) {
  const provider = await getProvider();
  if (provider === 'meta') return metaRegisterWebhook();
  if (provider === 'green') return greenRegisterWebhook(webhookUrl);
  
  // Internal Baileys does not need webhook registration
  return { success: true, note: 'Internal Baileys uses direct event listener' };
}

// ─── Message Formatting ───────────────────────────────────────────────────────

function formatItems(itemsJson) {
  try {
    const items = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson;
    if (!Array.isArray(items) || items.length === 0) return 'لا توجد منتجات';
    return items.map(item => `• ${item.name} × ${item.quantity} — ${item.price}`).join('\n');
  } catch {
    return String(itemsJson || 'لا توجد منتجات');
  }
}

function formatMessage(template, order) {
  if (!template || typeof template !== 'string') {
    template = 'مرحباً {name}\nتفاصيل طلبك: {items}\nالإجمالي: {total}';
  }
  let msg = template
    .replace(/{name}/g,         order.customer_name  || 'عزيزي العميل')
    .replace(/{order_number}/g, order.order_number   || '')
    .replace(/{items}/g,        formatItems(order.items))
    .replace(/{total}/g,        order.total          || '')
    .replace(/{address}/g,      order.address        || 'غير محدد');
  return msg.replace(/\\n/g, '\n');
}

async function getMessageTemplate() {
  let template = process.env.WHATSAPP_MESSAGE_TEMPLATE
    || 'مرحباً {name}\nتفاصيل طلبك: {items}\nالإجمالي: {total}';
  try {
    const { getSetting } = require('../database/db');
    const dbTemplate = await getSetting('WHATSAPP_MESSAGE_TEMPLATE');
    if (dbTemplate) template = dbTemplate;
  } catch {}
  if (typeof template === 'string' && !template.includes('DopaLess')) {
    template += '\\n\\nمن فريق عمل DopaLess 🛍️';
  }
  return template;
}

// ─── Special Messages ─────────────────────────────────────────────────────────

async function sendAbandonedCheckoutRecovery(checkout) {
  const urlMsg = checkout.checkout_url ? `\n\nتفضل رابط العودة:\n${checkout.checkout_url}` : '';
  const message = `مرحباً ${checkout.customer_name} 👋\n\nمن فريق عمل DopaLess 🛍️\n\nلاحظنا أنك لم تكمل طلبك بقيمة ${checkout.total}.${urlMsg}`;
  return sendWhatsAppMessageWithRetry(checkout.customer_phone, message);
}

async function getReviewTemplate() {
  let template = process.env.WHATSAPP_REVIEW_TEMPLATE
    || 'مرحباً {name} 👋\\n\\nبنطمن ان الاوردر وصل لحضرتك 📦\\nايه رأي حضرتك في المنتج؟ ونعتذر عن أي تأخير من شركة الشحن.\\n\\nمن فريق عمل DopaLess 🛍️';
  try {
    const { getSetting } = require('../database/db');
    const dbTemplate = await getSetting('WHATSAPP_REVIEW_TEMPLATE');
    if (dbTemplate) template = dbTemplate;
  } catch {}
  return template;
}

async function sendReviewRequest(order) {
  const template = await getReviewTemplate();
  const messageText = formatMessage(template, order);

  // تحقق لو فيه صورة للتقييم
  const reviewImageBase64 = await getSetting('WHATSAPP_REVIEW_IMAGE_BASE64').catch(() => null);
  const withImage = !!(reviewImageBase64 && reviewImageBase64.length > 100);

  console.log(`[WhatsApp] Sending review request to ${order.customer_phone} ${withImage ? '(with image)' : '(text only)'}`);
  return sendWhatsAppMessageWithRetry(order.customer_phone, messageText, withImage, 'WHATSAPP_REVIEW_IMAGE_BASE64');
}

module.exports = {
  normalizePhoneToWhatsApp,
  normalizePhone,
  sendWhatsAppMessage,
  sendWhatsAppMessageWithRetry,
  sendPollMessage,
  sendPollWithRetry,
  registerWebhook,
  formatMessage,
  formatItems,
  getMessageTemplate,
  getReviewTemplate,
  sendAbandonedCheckoutRecovery,
  sendReviewRequest,
  getProvider,
};

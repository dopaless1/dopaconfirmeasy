'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { verifyShopifyWebhook } = require('../middleware/verifyShopify');
const { parseShopifyOrder, cancelShopifyOrder, updateShopifyOrderTags } = require('../services/shopify');
const { parseEasyOrder } = require('../services/easyorders');
const { updateSourceStatus, cancelInSource } = require('../services/sourceAdapter');
const { sendWhatsAppMessageWithRetry, formatMessage, getMessageTemplate } = require('../services/whatsapp');
const { sendOrderToStarlink } = require('../services/starlink');
const { sendOrderToSpeedaf, matchGovernorateToSpeedafCode } = require('../services/speedaf');
const { notifyOwner } = require('./orders');

// ─── Shared keyword lists ─────────────────────────────────────────────────────
// Defined once here so Green API, Meta, and Baileys handlers all use
// the same exact set — no risk of them drifting apart over time.
const POSITIVE_KEYWORDS = [
  'نعم','yes','y','1','تمام','اوك','ok','اه','آه','ايه','أيه',
  'تاكيد','تأكيد','موافق','اكيد','أكيد','ايوه','أيوه',
  '✅ تأكيد الطلب','تأكيد الطلب','تاكيد الطلب','✅ تاكيد الطلب',
];
const NEGATIVE_KEYWORDS = [
  'لا','no','n','2','الغاء','إلغاء','الغي','إلغي','cancel','كلا','لأ',
  '❌ تعديل أو إلغاء','تعديل أو إلغاء','❌ تعديل او الغاء','تعديل او الغاء',
];

function isPositiveReply(textMessage) {
  const reply = textMessage.trim().toLowerCase();
  return textMessage.includes('✅') || POSITIVE_KEYWORDS.some(kw => reply === kw || reply.includes(kw));
}
function isNegativeReply(textMessage) {
  const reply = textMessage.trim().toLowerCase();
  return textMessage.includes('❌') || NEGATIVE_KEYWORDS.some(kw => reply === kw || reply.includes(kw));
}

// ─── Shopify Webhook ──────────────────────────────────────────────────────────

router.post('/shopify', verifyShopifyWebhook, async (req, res) => {
  const topic = req.get('X-Shopify-Topic') || 'unknown';
  const shop  = req.get('X-Shopify-Shop-Domain') || 'unknown';
  console.log(`[Webhook/Shopify] ✅ Received — topic: ${topic} | shop: ${shop}`);

  res.status(200).json({ received: true });

  if (topic === 'orders/delete') {
    const shopifyOrderId = String(req.body.id);
    // Soft-delete: move to trash instead of hard-deleting permanently.
    // This keeps the record available for history/reports and lets the
    // merchant restore it if the deletion was accidental.
    const existing = await db.getOrderByShopifyId(shopifyOrderId);
    if (existing) {
      await db.trashOrder(existing.id);
    }
    if (global.broadcastSSE) global.broadcastSSE({ type: 'order_deleted', order_id: shopifyOrderId });
    return;
  }

  if (topic === 'orders/cancelled') {
    const shopifyOrderId = String(req.body.id);
    // Only update if the order exists locally — silently skip unknown orders
    // (e.g. orders placed before this system was installed).
    const existing = await db.getOrderByShopifyId(shopifyOrderId);
    if (existing && existing.status !== 'cancelled') {
      await db.updateOrderStatus(shopifyOrderId, 'cancelled');
      updateShopifyOrderTags(shopifyOrderId, 'cancelled').catch(err => console.error('[Tags Error]', err.message));
      if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated', order_id: shopifyOrderId, status: 'cancelled' });
    }
    return;
  }

  const orderTopics    = ['orders/create', 'orders/created', 'orders/updated', 'orders/paid'];
  const checkoutTopics = ['checkouts/create', 'checkouts/update'];

  if (orderTopics.includes(topic)) {
    handleNewShopifyOrder(req.body, topic).catch(err => console.error('[Webhook/Shopify] Order error:', err));
  } else if (checkoutTopics.includes(topic)) {
    handleShopifyCheckout(req.body).catch(err => console.error('[Webhook/Shopify] Checkout error:', err));
  }
});

// ─── Easy Orders Webhook ──────────────────────────────────────────────────────

router.post('/easyorders', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook/EasyOrders] ✅ Received webhook payload:', JSON.stringify(payload));
    res.status(200).json({ received: true });

    if (!payload) return;

    // Easy Orders order event
    const topic = payload.event || payload.type || req.get('X-Event') || 'order.created';

    if (topic.includes('delete') || topic.includes('deleted')) {
      const orderId = String(payload.id || payload.order_id);
      const existing = await db.getOrderByShopifyId(orderId);
      if (existing) {
        await db.trashOrder(existing.id);
        if (global.broadcastSSE) global.broadcastSSE({ type: 'order_deleted', order_id: orderId });
      }
      return;
    }

    if (topic.includes('cancel') || topic.includes('cancelled') || topic.includes('canceled')) {
      const orderId = String(payload.id || payload.order_id);
      const existing = await db.getOrderByShopifyId(orderId);
      if (existing && existing.status !== 'cancelled') {
        await db.updateOrderStatus(orderId, 'cancelled');
        updateSourceStatus(existing, 'cancelled').catch(() => {});
        if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated', order_id: orderId, status: 'cancelled' });
      }
      return;
    }

    handleNewEasyOrder(payload, topic).catch(err => console.error('[Webhook/EasyOrders] Error:', err));
  } catch (err) {
    console.error('[Webhook/EasyOrders] Handler error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

async function handleNewEasyOrder(payload, topic = 'order.created') {
  let parsed = parseEasyOrder(payload);
  if (!parsed.easyorders_id) return;

  // If payload from webhook was minimal (missing phone, items, name or total), fetch full order from Easy Orders API
  if (!parsed.customer_phone || !parsed.items || parsed.items === '[]' || parsed.customer_name === 'عميل' || parsed.total === '0 EGP') {
    try {
      const { fetchEasyOrder } = require('../services/easyorders');
      const enriched = await fetchEasyOrder(parsed.easyorders_id);
      if (enriched.success && enriched.order) {
        parsed = parseEasyOrder(enriched.order);
      }
    } catch (e) {
      console.warn(`[Webhook/EasyOrders] Note: Could not enrich order ${parsed.easyorders_id}:`, e.message);
    }
  }

  console.log(`[Webhook/EasyOrders] 📦 Parsed order ${parsed.order_number} -> Name: "${parsed.customer_name}" | Phone: "${parsed.customer_phone}" | Items: ${parsed.items} | Total: "${parsed.total}"`);

  const insertResult = await db.insertOrder(parsed);

  if (insertResult.rowsAffected === 0) {
    await db.updateOrderDetails(parsed);
    const existing = await db.getOrderByShopifyId(parsed.shopify_order_id);
    if (global.broadcastSSE && existing) {
      global.broadcastSSE({ type: 'status_update', orderId: parsed.shopify_order_id, status: existing.status });
    }
    return;
  }

  // Update Easy Orders status to pending
  updateSourceStatus(parsed, 'pending_confirmation').catch(() => {});

  if (!parsed.customer_phone) {
    await db.updateOrderStatus(parsed.shopify_order_id, 'whatsapp_failed', { whatsapp_sent_at: new Date().toISOString() });
    updateSourceStatus(parsed, 'whatsapp_failed').catch(() => {});
    return;
  }

  const order = await db.getOrderByShopifyId(parsed.shopify_order_id);
  if (global.broadcastSSE) global.broadcastSSE({ type: 'new_order', order_id: parsed.shopify_order_id });
  await sendOrScheduleConfirmation(order);
}

async function handleShopifyCheckout(payload) {
  if (!payload?.token) return;
  const phone = payload.customer?.phone || payload.shipping_address?.phone || payload.billing_address?.phone;
  if (!phone) return;

  const firstName = payload.customer?.first_name || payload.shipping_address?.first_name || '';
  const lastName  = payload.customer?.last_name  || payload.shipping_address?.last_name  || '';
  const customerName = `${firstName} ${lastName}`.trim() || 'عميل';

  await db.upsertAbandonedCheckout({
    checkout_token: payload.token,
    customer_name:  customerName,
    customer_phone: phone,
    total: `${payload.total_price} ${payload.currency || ''}`.trim(),
    checkout_url:   payload.abandoned_checkout_url,
  });
}

async function handleNewShopifyOrder(orderPayload, topic = 'orders/create') {
  if (!orderPayload?.id) return;

  const parsed = parseShopifyOrder(orderPayload);
  console.log(`[Webhook/Shopify] Processing order ${parsed.order_number} — phone: ${parsed.customer_phone || 'NONE'}`);

  const insertResult = await db.insertOrder(parsed);

  if (insertResult.rowsAffected === 0) {
    // Order already exists: update its details (name, phone, items, total,
    // address, raw_payload) so the local copy stays fresh.
    await db.updateOrderDetails(parsed);

    const existing = await db.getOrderByShopifyId(parsed.shopify_order_id);

    if (topic === 'orders/create' || topic === 'orders/created') {
      // Duplicate create webhook — reset to pending and re-send.
      await db.updateOrderStatus(parsed.shopify_order_id, 'pending_confirmation');
      updateShopifyOrderTags(parsed.shopify_order_id, 'pending_confirmation').catch(e => {});
      await sendOrScheduleConfirmation(await db.getOrderByShopifyId(parsed.shopify_order_id));
    }
    // For orders/updated: ONLY update the stored data — do NOT re-send
    // WhatsApp messages. Shopify fires orders/updated for many reasons
    // (address change, note added, partial refund, tag update, etc.) and
    // re-sending a confirmation on every one of those would spam the
    // customer. Failed orders are retried exclusively by the AutoRetry job.

    // Broadcast status_update so dashboard refreshes the updated details
    if (global.broadcastSSE && existing) {
      global.broadcastSSE({ type: 'status_update', orderId: parsed.shopify_order_id, status: existing.status });
    }
    return;
  }

  // Update Shopify tag for a new order
  updateShopifyOrderTags(parsed.shopify_order_id, 'pending_confirmation').catch(e => {});

  if (!parsed.customer_phone) {
    await db.updateOrderStatus(parsed.shopify_order_id, 'whatsapp_failed', { whatsapp_sent_at: new Date().toISOString() });
    updateShopifyOrderTags(parsed.shopify_order_id, 'whatsapp_failed').catch(e => {});
    return;
  }

  const order = await db.getOrderByShopifyId(parsed.shopify_order_id);
  // Broadcast new order to dashboard
  if (global.broadcastSSE) global.broadcastSSE({ type: 'new_order', order_id: parsed.shopify_order_id });
  await sendOrScheduleConfirmation(order);
}

// ─── Delayed WhatsApp Dispatch ──────────────────────────────────────────────────────────────────────
// لو WHATSAPP_DELAY_MINUTES > 0: احفظ وقت الإرسال في notes وسيب Job يبعت
// لو = 0: ابعت فوراً (السلوك الأصلي)
async function sendOrScheduleConfirmation(order) {
  if (!order) return;
  try {
    const delayMinSetting = await db.getSetting('WHATSAPP_DELAY_MINUTES');
    let delayMinutes = 0;
    if (delayMinSetting !== undefined && delayMinSetting !== null && delayMinSetting !== '') {
      delayMinutes = parseFloat(delayMinSetting) || 0;
    } else {
      delayMinutes = (parseFloat(await db.getSetting('WHATSAPP_DELAY_HOURS') || '0') || 0) * 60;
    }

    if (delayMinutes > 0) {
      const sendAfter = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
      let notes = {};
      try { notes = JSON.parse(order.notes || '{}'); } catch {}
      notes.whatsapp_send_after = sendAfter;
      await db.updateOrderNotes(order.id, JSON.stringify(notes));
      console.log(`[WA] ⏰ Order ${order.order_number} — WhatsApp scheduled for ${sendAfter} (delay: ${delayMinutes}m)`);
    } else {
      await sendConfirmationWhatsApp(order);
    }
  } catch (e) {
    console.error('[WA] sendOrScheduleConfirmation error:', e.message);
  }
}

async function sendConfirmationWhatsApp(order) {
  if (!order) return;
  const template = await getMessageTemplate();
  if (!template) {
    await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_failed');
    updateShopifyOrderTags(order.shopify_order_id, 'whatsapp_failed').catch(e => {});
    return;
  }

  const { sendWhatsAppMessageWithRetry, sendPollWithRetry } = require('../services/whatsapp');
  const messageText = formatMessage(template, order);
  const resultText  = await sendWhatsAppMessageWithRetry(order.customer_phone, messageText, true);

  const pollMessage = 'برجاء اختيار تأكيد الطلب من الخيارات بالأسفل لتسريع عملية الشحن:';
  const pollOptions = [{ optionName: '✅ تأكيد الطلب' }, { optionName: '❌ تعديل أو إلغاء' }];
  const resultPoll  = await sendPollWithRetry(order.customer_phone, pollMessage, pollOptions, order.shopify_order_id);

  const now = new Date().toISOString();

  if (!resultText.success && !resultPoll.success) {
    // ❌ الرسالة والـ Poll كلهم فشلوا — ما وصلش حاجة
    console.warn(`[WA] ❌ Both message and poll failed for order ${order.order_number}`);
    await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_failed', { whatsapp_sent_at: now });
    updateShopifyOrderTags(order.shopify_order_id, 'whatsapp_failed').catch(e => {});
    notifyOwner(`❌ فشل إرسال واتساب\nالأوردر: ${order.order_number}\nالعميل: ${order.customer_name}\nالهاتف: ${order.customer_phone}`).catch(e => {});
    return;
  }

  // ✅ الرسالة وصلت (حتى لو الـ Poll فشل) — نحفظ الـ session عشان نقبل الرد النصي
  await db.upsertWhatsappSession(order.customer_phone, order.shopify_order_id);

  if (resultText.success && resultPoll.success) {
    // ✅ كل حاجة تمام
    console.log(`[WA] ✅ Message + Poll sent for order ${order.order_number}`);
    await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_sent', { whatsapp_sent_at: now });
    updateShopifyOrderTags(order.shopify_order_id, 'whatsapp_sent').catch(e => {});
  } else {
    // ⚠️ الرسالة وصلت بس Poll فشل — العميل ممكن يرد نصياً بـ "نعم"
    console.warn(`[WA] ⚠️ Message sent but Poll failed for order ${order.order_number} — text reply will still work`);
    await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_sent', { whatsapp_sent_at: now });
    updateShopifyOrderTags(order.shopify_order_id, 'whatsapp_sent').catch(e => {});
  }
}

// ─── WhatsApp Webhook ─────────────────────────────────────────────────────────

router.post('/whatsapp', async (req, res) => {
  res.status(200).json({ received: true });

  const body = req.body;
  if (body?.typeWebhook !== 'incomingMessageReceived') return;

  const messageData = body.messageData;
  if (!messageData) return;

  const msgType = messageData.typeMessage;
  let textMessage = '';
  let senderPhone = body.senderData?.sender || body.senderData?.chatId || '';

  if (msgType === 'pollUpdateMessage') {
    const pollData = messageData.pollUpdateMessageData || messageData.pollMessageData || messageData.pollVoteMessageData;
    if (pollData?.votes) {
      const selected = pollData.votes.find(v => v.optionVoters?.length > 0);
      if (selected) { textMessage = selected.optionName; senderPhone = selected.optionVoters[0]; }
    }
  } else if (msgType === 'textMessage' || msgType === 'extendedTextMessage') {
    textMessage = messageData.textMessageData?.textMessage || messageData.extendedTextMessageData?.text || '';
  } else {
    return;
  }

  if (!senderPhone || !textMessage.trim()) return;

  await processIncomingWhatsAppMessage(senderPhone, textMessage);

  // For Meta/GreenAPI, the response was already sent on line 135
});

async function processIncomingWhatsAppMessage(senderPhone, textMessage, explicitOrderId = null) {
  // Ensure we don't crash the server on unhandled rejections
  try {
    const cleanPhone = String(senderPhone || '').replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@lid', '').replace(/^\+/, '').trim();
    console.log(`[WA Webhook] 📩 Processing reply from ${cleanPhone} (explicitOrderId: ${explicitOrderId || 'NONE'}): "${textMessage}"`);

    let order = null;
    if (explicitOrderId) {
      order = await db.getOrderByShopifyId(explicitOrderId);
      if (order) console.log(`[WA Webhook] 🎯 Directly matched order by Poll metadata: ${order.order_number}`);
    }

    if (!order) {
      const session = await db.getSessionByPhone(cleanPhone);
      if (session && session.order_id) {
        console.log(`[WA Webhook] Session found — order_id: ${session.order_id}`);
        order = await db.getOrderByShopifyId(session.order_id);
      }
    }

    if (!order) {
      console.log(`[WA Webhook] Fallback: Searching latest active order for phone/LID ${cleanPhone}`);
      order = await db.getLatestActiveOrderByPhone(cleanPhone);
    }

    if (!order) {
      console.log(`[WA Webhook] ❌ No active order found for phone: ${cleanPhone}`);
      return;
    }

    console.log(`[WA Webhook] 🎯 Order found — status: ${order.status} | order: ${order.order_number}`);

    if (order.status === 'delivered') {
      const starCount = (textMessage.match(/⭐/g) || []).length;
      if (starCount > 0) {
        await db.updateOrderRating(String(order.shopify_order_id), starCount);
        const { sendWhatsAppMessage } = require('../services/whatsapp');
        await sendWhatsAppMessage(order.customer_phone, 'شكراً لتقييمك يا فندم! سعداء بخدمتك دايماً 💖');
      }
      return;
    }

    if (['confirmed', 'cancelled', 'shipping_sent', 'shipping_failed'].includes(order.status)) {
      console.log(`[WA Webhook] Order already at final status: ${order.status} — ignoring`);
      return;
    }

    const reply = textMessage.trim().toLowerCase();
    const now   = new Date().toISOString();
    const shopifyOrderId = String(order.shopify_order_id);

    const isPositive = isPositiveReply(textMessage);
    const isNegative = isNegativeReply(textMessage);

    console.log(`[WA Webhook] isPositive: ${isPositive} | isNegative: ${isNegative}`);

    if (isPositive) {
      console.log(`[WA Webhook] ✅ Confirming order ${order.order_number}`);
      await db.updateOrderStatus(shopifyOrderId, 'confirmed', { customer_reply: textMessage, replied_at: now });
      updateSourceStatus(order, 'confirmed').catch(e => {});

      const shippingMode = await db.getSetting('SHIPPING_MODE');
      if (shippingMode === 'speedaf_auto' && !String(shopifyOrderId).startsWith('SIM-')) {
        let speedafResult = { success: false };
        const { matchGovernorateToSpeedafCode, matchAreaWithGemini, sendOrderToSpeedaf } = require('../services/speedaf');
        
        let govMatch = await matchGovernorateToSpeedafCode(order.address);
        if (govMatch) {
          const areaMatch = await matchAreaWithGemini({ address: order.address, provinceCode: govMatch.code, provinceName: govMatch.name_ar || govMatch.name });
          const districtCode = areaMatch?.matched?.code || '';
          const districtName = areaMatch?.matched?.name_ar || '';
          const locationCodes = {
            provinceCode: govMatch.code,
            provinceName: govMatch.name_ar || govMatch.name,
            districtCode: districtCode,
            districtName: districtName,
            cityName: districtName,
            cityCode: districtCode,
          };
          speedafResult = await sendOrderToSpeedaf(order, locationCodes);
        } else {
          // If no area code match yet, mark confirmed so merchant selects areas in Modal
          speedafResult = { success: false, error: 'يتطلب اختيار المدينة والحي من الداشبورد' };
        }

        const { sendWhatsAppMessage } = require('../services/whatsapp');
        if (speedafResult.success) {
          await db.updateOrderStatus(shopifyOrderId, 'shipping_sent', { shipping_sent_at: now });
          updateSourceStatus(order, 'shipping_sent').catch(e => {});
          if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'shipping_sent' });
          await sendWhatsAppMessage(cleanPhone, '✅ تم تأكيد طلبك بنجاح وجاري تجهيزه للشحن! 🚚\nسيقوم المندوب بالتواصل معك قريباً.');
        } else {
          if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'confirmed' });
          await sendWhatsAppMessage(cleanPhone, '✅ تم تأكيد طلبك بنجاح وجاري تجهيزه للشحن! 🚚\nسيقوم المندوب بالتواصل معك قريباً.');
        }
      } else if (shippingMode === 'starlink_auto') {
        const rawPayload = typeof order.raw_payload === 'string' ? order.raw_payload : JSON.stringify(order.raw_payload);
        console.log(`[WA Webhook] Sending to Starlink — payload size: ${rawPayload?.length || 0} bytes`);
        
        const starlinkResult = await sendOrderToStarlink(rawPayload);
        console.log(`[WA Webhook] Starlink result:`, JSON.stringify(starlinkResult));

        if (starlinkResult.success) {
          await db.updateOrderStatus(shopifyOrderId, 'shipping_sent', { shipping_sent_at: now });
          updateSourceStatus(order, 'shipping_sent').catch(e => {});
          if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'shipping_sent' });
          const { sendWhatsAppMessage } = require('../services/whatsapp');
          await sendWhatsAppMessage(cleanPhone, '✅ تم تأكيد طلبك بنجاح وجاري تجهيزه للشحن! 🚚\nسيقوم المندوب بالتواصل معك قريباً.');
        } else {
          console.error(`[WA Webhook] ❌ Starlink failed: ${starlinkResult.error}`);
          await db.updateOrderStatus(shopifyOrderId, 'shipping_failed');
          updateSourceStatus(order, 'shipping_failed').catch(e => {});
          if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'shipping_failed' });
          const { sendWhatsAppMessage } = require('../services/whatsapp');
          await sendWhatsAppMessage(cleanPhone, 'عذراً، حدث خطأ تقني أثناء تحويل طلبك للشحن. سيقوم فريقنا بالتواصل معك قريباً.');
        }
      } else {
        if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'confirmed' });
        const { sendWhatsAppMessage } = require('../services/whatsapp');
        await sendWhatsAppMessage(cleanPhone, '✅ تم تأكيد طلبك بنجاح وجاري تجهيزه للشحن! 🚚\nسيقوم المندوب بالتواصل معك قريباً.');
      }
      await db.deleteSession(cleanPhone);

    } else if (isNegative) {
      console.log(`[WA Webhook] ❌ Cancelling order ${order.order_number}`);
      await db.updateOrderStatus(shopifyOrderId, 'cancelled', { customer_reply: textMessage, replied_at: now });
      updateSourceStatus(order, 'cancelled').catch(e => {});
      await cancelInSource(order, 'customer').catch(e => console.warn('[WA Webhook] Cancel error:', e.message));
      if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'cancelled' });
      const { sendWhatsAppMessage } = require('../services/whatsapp');
      await sendWhatsAppMessage(cleanPhone, '❌ تم تسجيل طلب إلغاء/تعديل الأوردر. سيتواصل معك أحد ممثلي خدمة العملاء في أقرب وقت.');
      await db.deleteSession(cleanPhone);
    } else {
      console.log(`[WA Webhook] ❓ Unrecognized reply: "${textMessage}"`);
    }
  } catch (err) {
    console.error(`[WA Webhook] Error processing incoming message:`, err);
  }
}


// ─── Meta WhatsApp Webhook ────────────────────────────────────────────────────

// GET /webhook/meta — Meta verification challenge
router.get('/meta', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'dopaconfirm_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhook/Meta] ✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook/Meta] ❌ Verification failed');
  return res.sendStatus(403);
});

// POST /webhook/meta — receive incoming Meta messages
router.post('/meta', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value || change.field !== 'messages') continue;

        for (const msg of value.messages || []) {
          const senderPhone = msg.from; // e.g. "201012345678"
          let textMessage = '';

          if (msg.type === 'text') {
            textMessage = msg.text?.body || '';
          } else if (msg.type === 'interactive') {
            // Button reply or list reply
            textMessage = msg.interactive?.button_reply?.title
                       || msg.interactive?.list_reply?.title
                       || '';
          } else {
            continue;
          }

          if (!senderPhone || !textMessage.trim()) continue;

          console.log(`[Webhook/Meta] Message from ${senderPhone}: "${textMessage}"`);

          const cleanPhone = senderPhone.replace(/^\+/, '');
          const session = await db.getSessionByPhone(cleanPhone);
          if (!session) {
            console.log(`[Webhook/Meta] No session for ${cleanPhone}`);
            continue;
          }

          const orderId = String(session.order_id);
          const order   = await db.getOrderByShopifyId(orderId);
          if (!order) continue;

          if (['confirmed','cancelled','shipping_sent','shipping_failed'].includes(order.status)) continue;

          const reply = textMessage.trim().toLowerCase();
          const now   = new Date().toISOString();
          const shopifyOrderId = String(order.shopify_order_id);

          const isPositive = isPositiveReply(textMessage);
          const isNegative = isNegativeReply(textMessage);

          const { sendWhatsAppMessage } = require('../services/whatsapp');

          if (isPositive) {
            console.log(`[Webhook/Meta] ✅ Confirming order ${order.order_number}`);
            await db.updateOrderStatus(shopifyOrderId, 'confirmed', { customer_reply: textMessage, replied_at: now });
            updateShopifyOrderTags(shopifyOrderId, 'confirmed').catch(e => {});

            const shippingMode = await db.getSetting('SHIPPING_MODE');
            if (shippingMode === 'auto') {
              const rawPayload = typeof order.raw_payload === 'string' ? order.raw_payload : JSON.stringify(order.raw_payload);
              const starlinkResult = await sendOrderToStarlink(rawPayload);

              if (starlinkResult.success) {
                await db.updateOrderStatus(shopifyOrderId, 'shipping_sent', { shipping_sent_at: now });
                updateShopifyOrderTags(shopifyOrderId, 'shipping_sent').catch(e => {});
                if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'shipping_sent' });
                await sendWhatsAppMessage(cleanPhone, '✅ تم تأكيد طلبك بنجاح وجاري تجهيزه للشحن! 🚚\nسيقوم المندوب بالتواصل معك قريباً.');
              } else {
                await db.updateOrderStatus(shopifyOrderId, 'shipping_failed');
                updateShopifyOrderTags(shopifyOrderId, 'shipping_failed').catch(e => {});
                if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'shipping_failed' });
                await sendWhatsAppMessage(cleanPhone, 'عذراً، حدث خطأ تقني. سيتواصل معك فريقنا قريباً.');
              }
            } else {
              if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'confirmed' });
              await sendWhatsAppMessage(cleanPhone, '✅ تم تأكيد طلبك بنجاح وجاري تجهيزه للشحن! 🚚\nسيقوم المندوب بالتواصل معك قريباً.');
            }
            await db.deleteSession(cleanPhone);

          } else if (isNegative) {
            console.log(`[Webhook/Meta] ❌ Cancelling order ${order.order_number}`);
            await db.updateOrderStatus(shopifyOrderId, 'cancelled', { customer_reply: textMessage, replied_at: now });
            updateShopifyOrderTags(shopifyOrderId, 'cancelled').catch(e => {});
            await cancelShopifyOrder(shopifyOrderId, 'customer').catch(() => {});
            if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: shopifyOrderId, status: 'cancelled' });
            await sendWhatsAppMessage(cleanPhone, '❌ تم تسجيل طلب إلغاء/تعديل الأوردر. سيتواصل معك أحد ممثلينا قريباً.');
            await db.deleteSession(cleanPhone);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Webhook/Meta] Error:', err.message);
  }
});

router.handleNewShopifyOrder = handleNewShopifyOrder;
router.handleNewEasyOrder = handleNewEasyOrder;
router.processIncomingWhatsAppMessage = processIncomingWhatsAppMessage;
module.exports = router;

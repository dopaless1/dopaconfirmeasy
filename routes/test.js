'use strict';

const express = require('express');
const router = express.Router();
const { sendOrderToStarlink } = require('../services/starlink');

// POST /api/test/whatsapp
router.post('/whatsapp', async (req, res) => {
  const { sendWhatsAppMessageWithRetry, sendPollWithRetry, formatMessage, getMessageTemplate } = require('../services/whatsapp');
  const { phone, order } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  // Use sample order if none provided
  const sampleOrder = order || {
    customer_name: 'عميل تجريبي',
    order_number: '#TEST-001',
    items: JSON.stringify([{ name: 'منتج تجريبي', quantity: 1, price: '100 EGP' }]),
    total: '100 EGP',
    address: 'القاهرة، مصر',
  };

  const template = await getMessageTemplate();
  const messageText = formatMessage(template, sampleOrder);
  const resultText = await sendWhatsAppMessageWithRetry(phone, messageText);
  const pollMessage = 'برجاء اختيار تأكيد الطلب من الخيارات بالأسفل:';
  const pollOptions = [{ optionName: '✅ تأكيد الطلب' }, { optionName: '❌ تعديل أو إلغاء' }];
  const result = await sendPollWithRetry(phone, pollMessage, pollOptions);
  res.json({ textResult: resultText, pollResult: result });
});

// POST /api/test/starlink
router.post('/starlink', async (req, res) => {
  const { sendTestToStarlink } = require('../services/starlink');
  const customPayload = req.body && Object.keys(req.body).length > 0 ? req.body : null;
  const result = await sendTestToStarlink(customPayload);
  res.json(result);
});

// GET /api/test/starlink-url
router.get('/starlink-url', (req, res) => {
  res.json({ url: process.env.STARLINK_API_URL || 'NOT SET', configured: !!process.env.STARLINK_API_URL });
});

// POST /api/test/shopify-webhook
router.post('/shopify-webhook', async (req, res) => {
  const webhookRouter = require('./webhook');
  const sampleOrder = req.body?.order || generateSampleOrder(req.body);
  try {
    await webhookRouter.handleNewShopifyOrder(sampleOrder);
    res.json({ success: true, order_id: String(sampleOrder.id), order_number: sampleOrder.name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/test/easyorders-webhook
router.post('/easyorders-webhook', async (req, res) => {
  const webhookRouter = require('./webhook');
  const sampleOrder = req.body?.order || generateSampleEasyOrder(req.body);
  try {
    await webhookRouter.handleNewEasyOrder(sampleOrder);
    res.json({ success: true, order_id: String(sampleOrder.id), order_number: sampleOrder.order_number });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/test/replay-to-starlink
router.post('/replay-to-starlink', async (req, res) => {
  const db = require('../database/db');
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });

  const order = await db.getOrderById(parseInt(order_id));
  if (!order) return res.status(404).json({ error: `Order ${order_id} not found` });
  if (!order.raw_payload) return res.status(400).json({ error: 'No raw_payload for this order' });

  const result = await sendOrderToStarlink(order.raw_payload);
  if (result.success) {
    await db.updateOrderStatus(order.shopify_order_id, 'shipping_sent', { shipping_sent_at: new Date().toISOString() });
  }
  res.json({ order_number: order.order_number, starlink: result });
});

// GET /api/test/debug
router.get('/debug', (req, res) => {
  res.json({
    node_version: process.version,
    shopify_store: process.env.SHOPIFY_STORE || 'NOT SET',
    green_api_instance: process.env.GREEN_API_INSTANCE_ID || 'NOT SET',
    turso_url: process.env.TURSO_DATABASE_URL || 'NOT SET ⚠️',
    public_url: process.env.PUBLIC_URL || 'NOT SET',
    uptime_seconds: Math.floor(process.uptime()),
  });
});

function generateSampleOrder(opts = {}) {
  const ts = Date.now();
  const num = Math.floor(Math.random() * 9000) + 1000;
  const phone = opts.phone || '+201012345678';
  const name  = opts.name  || 'أحمد محمد';
  const [firstName, ...rest] = name.split(' ');
  const lastName = rest.join(' ') || '';
  return {
    id: ts, name: `#SIM-${num}`, order_number: num,
    created_at: new Date().toISOString(), total_price: '299.00', currency: 'EGP',
    financial_status: 'pending', fulfillment_status: null,
    customer: { id: ts+1, first_name: firstName, last_name: lastName, email: 'test@test.com', phone },
    shipping_address: { first_name: firstName, last_name: lastName, address1: '5 شارع التحرير', city: 'القاهرة', country: 'Egypt', phone },
    billing_address:  { first_name: firstName, last_name: lastName, address1: '5 شارع التحرير', city: 'القاهرة', country: 'Egypt', phone },
    line_items: [{ id: ts+10, title: 'منتج تجريبي', quantity: 1, price: '299.00' }],
    shipping_lines: [{ title: 'توصيل مجاني', price: '0.00' }],
  };
}

function generateSampleEasyOrder(opts = {}) {
  const ts = Date.now();
  const num = Math.floor(Math.random() * 9000) + 1000;
  const phone = opts.phone || '01012345678';
  const name  = opts.name  || 'أحمد محمود';
  return {
    id: ts,
    order_number: `#EO-${num}`,
    customer_name: name,
    customer_phone: phone,
    governorate: 'الدقهلية',
    detailed_address: 'شارع المشاية السفلية، المنصورة',
    products: [
      { id: ts + 1, name: 'تيشيرت أوفر سايز', quantity: 1, price: 250, sku: 'TSH-01' }
    ],
    total: 250,
    currency: 'EGP',
  };
}

module.exports = router;

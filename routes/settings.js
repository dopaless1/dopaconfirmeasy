'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database/db');

const SETTING_KEYS = [
  'SHOPIFY_STORE', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_REDIRECT_URL',
  'GREEN_API_INSTANCE_ID', 'GREEN_API_TOKEN',
  'STARLINK_API_URL', 'WHATSAPP_MESSAGE_TEMPLATE',
  'DASHBOARD_PASSWORD', 'PORT', 'PUBLIC_URL',
  'WHATSAPP_PROVIDER', 'META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'META_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_REVIEW_TEMPLATE',
  'WHATSAPP_MESSAGE_IMAGE_BASE64',
  // ─── Feature Toggles ───────────────────────────────────
  'FEATURE_AUTO_RETRY',          // true/false — إعادة المحاولة التلقائية للأوردرات الفاشلة
  'FEATURE_ORDER_TIMEOUT',       // true/false — تذكير العميل + timeout
  'FEATURE_TIMEOUT_REMIND_HRS',  // رقم — ساعات قبل إرسال التذكير (default 6)
  'FEATURE_TIMEOUT_FINAL_HRS',   // رقم — ساعات قبل needs_follow_up (default 12)
  'FEATURE_DAILY_REPORT',        // true/false — تقرير يومي على واتساب
  'FEATURE_ABANDONED_CART',      // true/false — استرجاع السلات المتروكة (Shopify)
  'WHATSAPP_REVIEW_IMAGE_BASE64', // صورة رسالة التقييم
  'OWNER_ALERT_PHONE',           // رقم واتساب صاحب المتجر للتنبيهات
  'SITE_FAVICON_BASE64',         // أيقونة الموقع (favicon)
  'TASK_REMIND_HOURS_AHEAD',     // كام ساعة قبل موعد المهمة يتبعت تذكير واتساب للعامل
  'SHIPPING_MODE',               // وضع الشحن: manual | speedaf_auto | starlink_auto
  'WHATSAPP_DELAY_HOURS',        // تأخير إرسال واتساب بالساعات (0 = فوري)
  'WHATSAPP_DELAY_MINUTES',      // تأخير إرسال واتساب بالدقائق (0 = فوري)
  // ─── Order Source (SaaS Configuration) ───────────────────
  'ORDER_SOURCE',                // shopify | easyorders | both
  'EASYORDERS_API_KEY',          // مفتاح الـ API لمنصة Easy Orders
  'EASYORDERS_BASE_URL',         // رابط الـ API لمنصة Easy Orders
  // ─── Speedaf Direct Dashboard API ─────────────────────────
  'SPEEDAF_TOKEN',               // توكن جلسة الداشبورد (Cookie token)
  'SPEEDAF_ACCOUNT',             // اسم حساب Speedaf
  'SPEEDAF_PASSWORD',            // كلمة مرور Speedaf
  'GEMINI_API_KEY',              // مفتاح Google Gemini لحل الكابتشا والمطابقة الذكية
  'SPEEDAF_SENDER_NAME',         // اسم الراسل (DopaLess)
  'SPEEDAF_SENDER_PHONE',        // هاتف الراسل (01032462703)
  'SPEEDAF_SENDER_ADDRESS',      // عنوان الراسل (المنصورة)
  'SPEEDAF_SENDER_PROVINCE_CODE',// كود محافظة الراسل (EGR00166)
  'SPEEDAF_SENDER_PROVINCE_NAME',// اسم محافظة الراسل (الدقهلية)
  'SPEEDAF_SENDER_CITY_CODE',    // كود مدينة الراسل (EGC00675)
  'SPEEDAF_SENDER_CITY_NAME',    // اسم مدينة الراسل (المنصورة)
  'SPEEDAF_SENDER_DISTRICT_CODE',// كود حي الراسل (EGA05026)
  'SPEEDAF_SENDER_DISTRICT_NAME',// اسم حي الراسل (المنصورة)
  // ─── Legacy Speedaf Shipping API ─────────────────────────
  'SPEEDAF_API_URL',
  'SPEEDAF_APP_KEY',
  'SPEEDAF_APP_SECRET',
];


// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const result = {};
    for (const key of SETTING_KEYS) {
      const dbVal = await db.getSetting(key);
      result[key] = dbVal !== null ? dbVal : (process.env[key] || '');
    }
    if (result.DASHBOARD_PASSWORD) {
      result.DASHBOARD_PASSWORD_SET = result.DASHBOARD_PASSWORD.length > 0;
      delete result.DASHBOARD_PASSWORD;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings
router.post('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid payload' });

    const filtered = {};
    for (const key of SETTING_KEYS) {
      if (updates[key] !== undefined && updates[key] !== null) {
        filtered[key] = String(updates[key]);
      }
    }

    await db.setSettings(filtered);

    for (const [key, value] of Object.entries(filtered)) {
      if (key === 'WHATSAPP_MESSAGE_IMAGE_BASE64') continue; // كبيرة جدًا، اتقرأ من DB مباشرة وقت الإرسال
      process.env[key] = value;
    }

    res.json({ success: true, updated: Object.keys(filtered) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/register-webhook
router.post('/register-webhook', async (req, res) => {
  try {
    const { registerWebhook, getProvider } = require('../services/whatsapp');
    const provider = await getProvider();
    
    if (provider === 'meta') {
      return res.status(400).json({ success: false, error: 'Cannot register webhook via API for Meta. Use Meta Developer Console.' });
    }

    const publicUrl = await db.getSetting('PUBLIC_URL') || process.env.PUBLIC_URL;
    if (!publicUrl) {
      return res.status(400).json({ success: false, error: 'PUBLIC_URL is not set in settings' });
    }

    // Ensure it doesn't have a trailing slash
    const baseUrl = publicUrl.replace(/\/$/, '');
    const webhookUrl = `${baseUrl}/webhook/whatsapp`;

    const result = await registerWebhook(webhookUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

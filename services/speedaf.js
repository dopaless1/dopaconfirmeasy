'use strict';

/**
 * Speedaf Direct Dashboard API Integration
 * ──────────────────────────────────────────
 * Uses Speedaf's internal dashboard API (csp.speedaf.com)
 * with cookie-based token authentication.
 *
 * Authentication: Cookie token (long-lived ~68 year session)
 * Base URL: https://csp.speedaf.com/v1/api
 *
 * Required settings:
 *   SPEEDAF_TOKEN       — Cookie token from dashboard login
 *   SPEEDAF_SENDER_*    — Sender details (name, phone, address, area codes)
 *
 * Discovered API endpoints (from JS bundle analysis):
 *   POST /express/order/add              — Create shipment
 *   GET  /express/order/getOrder         — Get single order
 *   GET  /express/order/getStatistics    — Dashboard statistics
 *   GET  /express/order/getOrderList     — List orders (paginated)
 *   GET  /express/order/queryOrderList   — Search orders
 *   GET  /common/area/findAreaListByParentCode — Get sub-areas
 *   GET  /express/billing/balance        — Account balance
 *   GET  /express/address/book/getSenderInformations — Sender info
 */

const crypto = require('crypto');
const db = require('../database/db');

const BASE_URL = 'https://csp.speedaf.com/v1/api';

// ─── AES Encryption (from Speedaf's JS bundle) ─────────────────────────────
// Used for password encryption during login
const AES_KEY = Buffer.from('f351ddc7e3698ab8', 'utf8');
const AES_IV  = Buffer.from('02f3b743271aef51', 'utf8');

function encryptPassword(password) {
  const input = Buffer.from(password, 'utf8');
  const blockSize = 16;
  const padded = Buffer.alloc(Math.ceil(input.length / blockSize) * blockSize, 0);
  input.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString('base64');
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

async function getSetting(key) {
  try {
    const val = await db.getSetting(key);
    if (val !== null && val !== undefined && val !== '') return val;
  } catch {}
  return process.env[key] || '';
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

const https = require('https');

function httpPost(url, data, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const postData = typeof data === 'string' ? data : JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, data: body, headers: res.headers }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(postData);
    req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, data: body, headers: res.headers }); }
      });
    }).on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

// ─── Captcha & Gemini Vision Auto-Login ──────────────────────────────────────

async function fetchSpeedafCaptcha() {
  const res = await httpGet('https://csp.speedaf.com/v1/api/common/verify/code/getImageVerifyCode');
  if (res.status === 200 && res.data?.success && res.data?.data) {
    const { uuid, base64Code } = res.data.data;
    const cleanBase64 = (base64Code || '').replace(/^data:image\/\w+;base64,/, '');
    return { uuid, cleanBase64 };
  }
  return null;
}

async function solveCaptchaWithGemini(base64Image, geminiApiKey) {
  const models = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
      const payload = {
        contents: [
          {
            parts: [
              {
                text: 'Read the exact 4-character alphanumeric captcha code in this image. Return ONLY the 4 characters, uppercase letters and digits, no extra text, no spaces.'
              },
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: base64Image
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 10,
        }
      };

      const res = await httpPost(url, payload);
      if (res.status === 200 && res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const text = res.data.candidates[0].content.parts[0].text.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (text.length >= 4) return text.substring(0, 4);
      }
    } catch (e) {
      console.warn(`[Speedaf/Gemini] Model ${model} failed:`, e.message);
    }
  }
  return null;
}

async function loginSpeedafWithCaptcha(account, password, verifyCode, uuid) {
  const encryptedPassword = encryptPassword(password);
  const res = await httpPost('https://csp.speedaf.com/v1/api/security/login/doLogin', {
    account,
    password: encryptedPassword,
    verifyCode,
    uuid,
  }, {
    'Origin': 'https://csp.speedaf.com',
    'Referer': 'https://csp.speedaf.com/login',
  });
  return res;
}

/**
 * تسجيل الدخول التلقائي لـ Speedaf وحل الكابتشا عبر Gemini
 */
async function autoLoginSpeedaf(maxRetries = 3) {
  const geminiKey = await getSetting('GEMINI_API_KEY');
  const account = (await getSetting('SPEEDAF_ACCOUNT')) || 'EG004774001';
  const password = (await getSetting('SPEEDAF_PASSWORD')) || 'DAP786786';

  if (!geminiKey) {
    return { success: false, error: 'GEMINI_API_KEY غير محدد في الإعدادات لحل الكابتشا تلقائياً' };
  }

  console.log(`[Speedaf/AutoLogin] Starting auto-login for account: ${account}...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Speedaf/AutoLogin] Attempt ${attempt}/${maxRetries}: Fetching captcha...`);
      const captcha = await fetchSpeedafCaptcha();
      if (!captcha) {
        console.warn('[Speedaf/AutoLogin] Failed to fetch captcha from Speedaf');
        continue;
      }

      console.log(`[Speedaf/AutoLogin] Solving captcha via Gemini AI...`);
      const solvedCode = await solveCaptchaWithGemini(captcha.cleanBase64, geminiKey);
      if (!solvedCode) {
        console.warn('[Speedaf/AutoLogin] Gemini could not read captcha, retrying...');
        continue;
      }

      console.log(`[Speedaf/AutoLogin] Gemini read captcha as: [${solvedCode}] — Submitting login...`);
      const loginRes = await loginSpeedafWithCaptcha(account, password, solvedCode, captcha.uuid);

      let token = loginRes.data?.data?.token || loginRes.data?.token;

      // Also check set-cookie header if token was sent via cookie
      if (!token && loginRes.headers?.['set-cookie']) {
        const cookies = Array.isArray(loginRes.headers['set-cookie']) ? loginRes.headers['set-cookie'] : [loginRes.headers['set-cookie']];
        for (const c of cookies) {
          const m = c.match(/token=([^;]+)/);
          if (m) { token = m[1]; break; }
        }
      }

      if (token && (loginRes.data?.success !== false)) {
        console.log(`[Speedaf/AutoLogin] ✅ Login successful! New token: ${token.substring(0, 8)}...`);
        await db.setSetting('SPEEDAF_TOKEN', token);
        process.env.SPEEDAF_TOKEN = token;
        return { success: true, token, message: 'تم تسجيل الدخول وتحديث التوكن بنجاح!' };
      } else {
        const errMsg = loginRes.data?.error?.message || loginRes.data?.message || 'فشل التحقق من الكود';
        console.warn(`[Speedaf/AutoLogin] Attempt ${attempt} failed: ${errMsg}`);
      }
    } catch (err) {
      console.error(`[Speedaf/AutoLogin] Error on attempt ${attempt}:`, err.message);
    }
  }

  return { success: false, error: 'فشل تسجيل الدخول التلقائي بعد عدة محاولات (تأكد من صحة الحساب ومفتاح Gemini)' };
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

function speedafRequest(method, path, body = null, retryCount = 0) {
  return new Promise(async (resolve) => {
    let token = await getSetting('SPEEDAF_TOKEN');
    if (!token) {
      // Try auto-login if token is missing
      const loginRes = await autoLoginSpeedaf();
      if (loginRes.success) {
        token = loginRes.token;
      } else {
        resolve({ success: false, status: 0, data: null, error: 'SPEEDAF_TOKEN مش متحدد وفشل تسجيل الدخول التلقائي' });
        return;
      }
    }

    const url = `${BASE_URL}${path}`;
    const urlObj = new URL(url);

    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Cookie': `token=${token}; lang=en`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://csp.speedaf.com',
        'Referer': 'https://csp.speedaf.com/',
      },
    };

    console.log(`[Speedaf] → ${method} ${path}`);

    const req = https.request(opts, (res) => {
      let rawData = '';
      res.on('data', c => rawData += c);
      res.on('end', async () => {
        let data;
        try { data = JSON.parse(rawData); } catch { data = rawData; }

        const httpOk = res.statusCode >= 200 && res.statusCode < 300;
        const apiOk = data?.success === true;

        // Token expired check (911 or 401) — auto refresh token and retry
        if ((data?.error?.code === '911' || res.statusCode === 401) && retryCount === 0) {
          console.warn('[Speedaf] ⚠️ Token expired! Attempting auto-login via Gemini...');
          const loginRes = await autoLoginSpeedaf();
          if (loginRes.success) {
            console.log('[Speedaf] 🔄 Retrying original request with fresh token...');
            const retryRes = await speedafRequest(method, path, body, retryCount + 1);
            resolve(retryRes);
            return;
          }
        }

        console.log(`[Speedaf] ← HTTP ${res.statusCode} | success: ${apiOk} | ${JSON.stringify(data).substring(0, 200)}`);
        resolve({ success: httpOk && apiOk, status: res.statusCode, data, error: data?.error?.message || null });
      });
    });

    req.on('error', (e) => {
      console.error(`[Speedaf] ❌ Network error: ${e.message}`);
      resolve({ success: false, status: 0, data: null, error: e.message });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ success: false, status: 0, data: null, error: 'Request timeout (30s)' });
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Test Connection ──────────────────────────────────────────────────────────

async function testSpeedafConnection() {
  const result = await speedafRequest('GET', '/express/billing/balance');
  if (result.success) {
    console.log('[Speedaf] ✅ Connection test passed');
    return { success: true, balance: result.data?.data, message: 'Connected successfully' };
  }
  return { success: false, error: result.error || `HTTP ${result.status}` };
}

// ─── Area Codes ───────────────────────────────────────────────────────────────

async function fetchSpeedafAreas(parentCode, type = 1) {
  // الـ API بياخد parentCode + type كـ query params
  // type=0: countries, type=1: provinces, type=2: cities, etc.
  const result = await speedafRequest('GET', `/common/area/findAreaListByParentCode?parentCode=${encodeURIComponent(parentCode)}&type=${type}&countryCode=EG`);
  if (result.success && Array.isArray(result.data?.data) && result.data.data.length > 0) {
    return { success: true, areas: result.data.data };
  }
  // Fallback: try without type
  const result2 = await speedafRequest('GET', `/common/area/findAreaListByParentCode?parentCode=${encodeURIComponent(parentCode)}`);
  if (result2.success && Array.isArray(result2.data?.data) && result2.data.data.length > 0) {
    return { success: true, areas: result2.data.data };
  }
  return { success: false, areas: [], error: result.error || 'No areas returned' };
}

// ─── Egyptian Governorate Fallback ────────────────────────────────────────────
// أكواد المحافظات المصرية المعروفة من بيانات Speedaf الحقيقية
// بتتستخدم لو الـ API مرجعش بيانات (حساب العميل ممكن مالوش صلاحية)
const EGYPT_GOVERNORATES_FALLBACK = [
  { code: 'EGR00160', name: 'Alexandria', nameAr: 'الإسكندرية' },
  { code: 'EGR00166', name: 'Dakahlia', nameAr: 'الدقهلية' },
  { code: 'EGR00161', name: 'Cairo', nameAr: 'القاهرة' },
  { code: 'EGR00162', name: 'Giza', nameAr: 'الجيزة' },
  { code: 'EGR00163', name: 'Qalyubia', nameAr: 'القليوبية' },
  { code: 'EGR00164', name: 'Sharqia', nameAr: 'الشرقية' },
  { code: 'EGR00165', name: 'Gharbia', nameAr: 'الغربية' },
  { code: 'EGR00167', name: 'Beheira', nameAr: 'البحيرة' },
  { code: 'EGR00168', name: 'Menoufia', nameAr: 'المنوفية' },
  { code: 'EGR00169', name: 'Kafr El Sheikh', nameAr: 'كفر الشيخ' },
  { code: 'EGR00170', name: 'Damietta', nameAr: 'دمياط' },
  { code: 'EGR00171', name: 'Port Said', nameAr: 'بورسعيد' },
  { code: 'EGR00172', name: 'Ismailia', nameAr: 'الإسماعيلية' },
  { code: 'EGR00173', name: 'Suez', nameAr: 'السويس' },
  { code: 'EGR00174', name: 'Fayoum', nameAr: 'الفيوم' },
  { code: 'EGR00175', name: 'Beni Suef', nameAr: 'بني سويف' },
  { code: 'EGR00176', name: 'Minya', nameAr: 'المنيا' },
  { code: 'EGR00177', name: 'Asyut', nameAr: 'أسيوط' },
  { code: 'EGR00178', name: 'Sohag', nameAr: 'سوهاج' },
  { code: 'EGR00179', name: 'Qena', nameAr: 'قنا' },
  { code: 'EGR00180', name: 'Luxor', nameAr: 'الأقصر' },
  { code: 'EGR00181', name: 'Aswan', nameAr: 'أسوان' },
  { code: 'EGR00182', name: 'Red Sea', nameAr: 'البحر الأحمر' },
  { code: 'EGR00183', name: 'New Valley', nameAr: 'الوادي الجديد' },
  { code: 'EGR00184', name: 'Matruh', nameAr: 'مطروح' },
  { code: 'EGR00185', name: 'North Sinai', nameAr: 'شمال سيناء' },
  { code: 'EGR00186', name: 'South Sinai', nameAr: 'جنوب سيناء' },
];

/**
 * مزامنة كل أكواد المناطق من Speedaf وتخزينها في DB
 * المستويات: country → province → city → district
 */
async function syncAllAreas() {
  console.log('[Speedaf] 🔄 Starting full area sync...');
  let totalSynced = 0;

  // Level 1: Provinces (محافظات) — children of EG
  let provinces = [];
  const provResult = await fetchSpeedafAreas('EG', 1);
  
  if (provResult.success && provResult.areas.length > 0) {
    provinces = provResult.areas;
    console.log(`[Speedaf] ✅ Got ${provinces.length} provinces from API`);
  } else {
    // Fallback: use hardcoded Egyptian governorates
    console.log('[Speedaf] ⚠️ API returned no provinces — using fallback data');
    provinces = EGYPT_GOVERNORATES_FALLBACK.map(g => ({
      code: g.code, name: g.name, nameLocal: g.nameAr
    }));
  }

  for (const prov of provinces) {
    await db.upsertAreaCode({
      code: prov.code,
      name: prov.name,
      nameAr: prov.nameLocal || prov.nameAr || prov.name,
      parentCode: 'EG',
      level: 'province',
      fullPath: prov.nameLocal || prov.nameAr || prov.name,
    });
    totalSynced++;

    // Level 2: Cities — children of province
    const cityResult = await fetchSpeedafAreas(prov.code, 2);
    if (cityResult.success) {
      for (const city of cityResult.areas) {
        const provName = prov.nameLocal || prov.nameAr || prov.name;
        const cityName = city.nameLocal || city.name;
        await db.upsertAreaCode({
          code: city.code,
          name: city.name,
          nameAr: city.nameLocal || city.name,
          parentCode: prov.code,
          level: 'city',
          fullPath: `${provName} > ${cityName}`,
        });
        totalSynced++;

        // Level 3: Districts — children of city
        const distResult = await fetchSpeedafAreas(city.code, 3);
        if (distResult.success) {
          for (const dist of distResult.areas) {
            await db.upsertAreaCode({
              code: dist.code,
              name: dist.name,
              nameAr: dist.nameLocal || dist.name,
              parentCode: city.code,
              level: 'district',
              fullPath: `${provName} > ${cityName} > ${dist.nameLocal || dist.name}`,
            });
            totalSynced++;
          }
        }
      }
    }
    console.log(`[Speedaf] ✅ Province "${prov.nameLocal || prov.name}" synced (total: ${totalSynced})`);
  }

  console.log(`[Speedaf] 🎉 Area sync complete — ${totalSynced} areas synced`);
  return { success: true, synced: totalSynced };
}

/**
 * مطابقة اسم المحافظة (من الأوردر) مع كود Speedaf
 */
async function matchGovernorateToSpeedafCode(governorateName) {
  if (!governorateName) return null;
  const areas = await db.searchAreas(governorateName.trim(), 'province');
  return areas.length > 0 ? areas[0] : null;
}

// ─── Sender Defaults ──────────────────────────────────────────────────────────

async function getSenderDefaults() {
  return {
    sendName: await getSetting('SPEEDAF_SENDER_NAME') || 'DopaLess',
    sendMobile: await getSetting('SPEEDAF_SENDER_PHONE') || '01032462703',
    sendAddress: await getSetting('SPEEDAF_SENDER_ADDRESS') || 'المنصورة',
    sendCountryCode: 'EG',
    sendCountryName: 'Egypt',
    sendProvinceCode: await getSetting('SPEEDAF_SENDER_PROVINCE_CODE') || 'EGR00166',
    sendProvinceName: await getSetting('SPEEDAF_SENDER_PROVINCE_NAME') || 'الدقهلية',
    sendCityCode: await getSetting('SPEEDAF_SENDER_CITY_CODE') || 'EGC00675',
    sendCityName: await getSetting('SPEEDAF_SENDER_CITY_NAME') || 'المنصورة',
    sendDistrictCode: await getSetting('SPEEDAF_SENDER_DISTRICT_CODE') || 'EGA05026',
    sendDistrictName: await getSetting('SPEEDAF_SENDER_DISTRICT_NAME') || 'المنصورة',
  };
}

// ─── Create Order (Shipment) ──────────────────────────────────────────────────

/**
 * إنشاء شحنة في Speedaf
 * @param {object} order - الأوردر من الـ DB
 * @param {object} locationCodes - أكواد المنطقة المختارة من الـ Modal
 *   { provinceCode, provinceName, cityCode, cityName, districtCode, districtName }
 */
async function sendOrderToSpeedaf(order, locationCodes) {
  // Validation
  const token = await getSetting('SPEEDAF_TOKEN');
  if (!token) {
    return { success: false, error: 'Speedaf غير مفعّل — أضف SPEEDAF_TOKEN في الإعدادات' };
  }

  if (!locationCodes || !locationCodes.provinceCode) {
    return { success: false, error: 'أكواد المنطقة مطلوبة — اختار المحافظة والمدينة والحي' };
  }

  // Simulated order bypass
  if (order.order_number && String(order.order_number).startsWith('#SIM-')) {
    console.log('[Speedaf] ⚠️ Simulated order — faking success');
    return { success: true, message: 'Simulated success', waybillNo: 'SIM-WAYBILL-001' };
  }

  try {
    // Parse order data
    let items = [];
    try { items = JSON.parse(order.items || '[]'); } catch {}
    const goodsName = items.map(i => i.name || i.title).join(', ').substring(0, 100) || 'منتج';
    const goodsQTY = items.reduce((sum, i) => sum + (i.quantity || 1), 0) || 1;

    // Parse address for the recipient
    let address = order.address || '';
    let customerName = order.customer_name || 'عميل';
    let customerPhone = order.customer_phone || '';

    // Extract from raw_payload if available
    let rawPayload = {};
    try { rawPayload = JSON.parse(order.raw_payload || '{}'); } catch {}

    if (rawPayload.shipping_address) {
      const sa = rawPayload.shipping_address;
      if (!address) {
        address = [sa.address1, sa.address2].filter(Boolean).join(', ');
      }
      if (!customerPhone) {
        customerPhone = sa.phone || rawPayload.customer?.phone || '';
      }
    }

    // COD amount
    const codFee = parseFloat(order.total) || 0;

    // Sender defaults
    const sender = await getSenderDefaults();

    // Build Speedaf payload
    const payload = {
      // Recipient (المستلم)
      acceptName: customerName,
      acceptMobile: customerPhone.replace(/^\+/, ''),
      acceptAddress: address,
      acceptCountryCode: 'EG',
      acceptCountryName: 'Egypt',
      acceptProvinceCode: locationCodes.provinceCode,
      acceptProvinceName: locationCodes.provinceName || '',
      acceptCityCode: locationCodes.cityCode || '',
      acceptCityName: locationCodes.cityName || '',
      acceptDistrictCode: locationCodes.districtCode || '',
      acceptDistrictName: locationCodes.districtName || '',
      acceptEmail: '',

      // Sender (المرسل) — fixed values
      ...sender,

      // Shipment details
      goodsName,
      goodsQTY,
      goodsWeight: 1,
      goodsType: 'IT01',
      goodsTypeName: 'Normal',
      codFee,
      paymentMethod: 'PA02',  // Cash on delivery
      isAllowOpen: 0,
      insurePrice: 0,
      shippingFee: 0,
      deliveryType: '',
      customOrderNo: order.order_number || '',
      remark: `Order ${order.order_number}`,
    };

    console.log(`[Speedaf] Creating shipment for order ${order.order_number} — COD: ${codFee} EGP`);

    const result = await speedafRequest('POST', '/express/order/add', payload);

    if (result.success) {
      // Try to extract waybill number from response
      const waybillNo = result.data?.data?.waybillNo || result.data?.data?.orderNo || null;
      console.log(`[Speedaf] ✅ Order created — Waybill: ${waybillNo}`);

      // Save waybill to DB
      if (waybillNo && order.id) {
        await db.updateSpeedafWaybill(order.id, waybillNo);
      }

      return { success: true, waybillNo, raw: result.data };
    }

    console.error(`[Speedaf] ❌ Order creation failed: ${result.error}`);
    return { success: false, error: result.error || 'Unknown error', raw: result.data };

  } catch (err) {
    console.error('[Speedaf] ❌ Exception:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Order Tracking ───────────────────────────────────────────────────────────

/**
 * جلب تفاصيل شحنة واحدة من Speedaf
 */
async function trackOrder(waybillNo) {
  if (!waybillNo) return { success: false, error: 'Waybill number required' };
  const result = await speedafRequest('GET', `/express/order/getOrder?waybillNo=${encodeURIComponent(waybillNo)}`);
  if (result.success && result.data?.data) {
    return { success: true, order: result.data.data };
  }
  return { success: false, error: result.error };
}

/**
 * جلب قائمة الشحنات (paginated)
 */
async function getOrderList(pageNum = 1, pageSize = 50) {
  const result = await speedafRequest('GET', `/express/order/getGeneralOrderList?pageNum=${pageNum}&pageSize=${pageSize}`);
  if (result.success && result.data?.data) {
    return { success: true, orders: result.data.data.list || result.data.data, total: result.data.data.total || 0 };
  }
  return { success: false, orders: [], error: result.error };
}

/**
 * تتبع كل الشحنات النشطة وتحديث حالاتها في DB
 * بيتنده من الـ background job كل 30 دقيقة
 */
async function trackAllActiveOrders() {
  const activeOrders = await db.getOrdersWithActiveSpeedaf();
  if (activeOrders.length === 0) {
    console.log('[Speedaf] No active shipments to track');
    return { tracked: 0, updated: 0 };
  }

  console.log(`[Speedaf] 🔄 Tracking ${activeOrders.length} active shipments...`);
  let updated = 0;

  for (const order of activeOrders) {
    try {
      const result = await trackOrder(order.speedaf_waybill);
      if (result.success && result.order) {
        const speedafStatus = result.order.orderStatusName || result.order.orderStatus || '';
        const currentStatus = order.speedaf_status || '';

        if (speedafStatus && speedafStatus !== currentStatus) {
          await db.updateSpeedafStatus(order.id, speedafStatus);
          console.log(`[Speedaf] 📦 Order ${order.order_number}: ${currentStatus} → ${speedafStatus}`);
          updated++;

          // Map Speedaf status to internal status
          const internalStatus = mapSpeedafToInternalStatus(speedafStatus);
          if (internalStatus && internalStatus !== order.status) {
            await db.updateOrderStatus(order.shopify_order_id || order.easyorders_id, internalStatus);
            const { updateSourceStatus } = require('./sourceAdapter');
            await updateSourceStatus(order, internalStatus);

            if (global.broadcastSSE) {
              global.broadcastSSE({ type: 'status_update', orderId: order.shopify_order_id || order.id, status: internalStatus });
            }
          }
        }
      }
    } catch (e) {
      console.error(`[Speedaf] ❌ Tracking error for ${order.speedaf_waybill}:`, e.message);
    }
  }

  console.log(`[Speedaf] ✅ Tracking complete — ${updated}/${activeOrders.length} updated`);
  return { tracked: activeOrders.length, updated };
}

/**
 * مطابقة حالة Speedaf بالحالة الداخلية
 */
function mapSpeedafToInternalStatus(speedafStatus) {
  if (!speedafStatus) return null;
  const s = speedafStatus.toLowerCase();

  // Delivered
  if (s.includes('delivered') || s.includes('تم التسليم') || s.includes('signed') || s.includes('receipt') || s.includes('sign')) return 'delivered';
  // Returned / Cancelled
  if (s.includes('return') || s.includes('مرتجع') || s.includes('cancelled') || s.includes('ملغي')) return 'cancelled';
  // In transit / out for delivery
  if (s.includes('transit') || s.includes('delivery') || s.includes('في الشحن') || s.includes('قيد')) return 'shipping_sent';
  // Picked up
  if (s.includes('pickup') || s.includes('collected') || s.includes('تم الاستلام')) return 'handed_to_courier';

  return null; // Unknown — don't change internal status
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

async function getSpeedafStats() {
  const result = await speedafRequest('GET', '/express/order/getStatistics');
  if (result.success) {
    return { success: true, stats: result.data?.data };
  }
  return { success: false, error: result.error };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Core
  sendOrderToSpeedaf,
  testSpeedafConnection,
  // Area codes
  fetchSpeedafAreas,
  syncAllAreas,
  matchGovernorateToSpeedafCode,
  // Tracking
  trackOrder,
  trackAllActiveOrders,
  getOrderList,
  // Stats
  getSpeedafStats,
  // Auto-Login & Captcha
  autoLoginSpeedaf,
  fetchSpeedafCaptcha,
  solveCaptchaWithGemini,
  loginSpeedafWithCaptcha,
  // Utils
  encryptPassword,
  getSenderDefaults,
  mapSpeedafToInternalStatus,
};

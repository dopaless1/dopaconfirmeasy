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
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(postData);
    req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.get({
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
    });
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
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
  // Pool of distinct models each with their own separate RPM quotas
  const models = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const payload = {
        contents: [
          {
            parts: [
              {
                text: 'Read the exact 4-character alphanumeric captcha code in this image. Return ONLY the 4 characters, uppercase letters and digits, no extra text, no spaces, no punctuation.'
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

      const res = await httpPost(url, payload, { 'x-goog-api-key': geminiApiKey });
      if (res.status === 200 && res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const text = res.data.candidates[0].content.parts[0].text.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (text.length >= 4) return text.substring(0, 4);
      } else if (res.status === 429) {
        console.warn(`[Speedaf/Gemini] Model ${model} reached rate limit, switching to next model...`);
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
async function autoLoginSpeedaf(maxRetries = 3, overrides = {}) {
  const geminiKey = overrides.geminiApiKey || (await getSetting('GEMINI_API_KEY'));
  const account = overrides.account || (await getSetting('SPEEDAF_ACCOUNT')) || 'EG004774001';
  const password = overrides.password || (await getSetting('SPEEDAF_PASSWORD')) || 'DAP786786';

  if (!geminiKey) {
    return { success: false, error: 'GEMINI_API_KEY غير محدد في الإعدادات لحل الكابتشا تلقائياً' };
  }

  // Save them if provided in overrides
  if (overrides.geminiApiKey) db.setSetting('GEMINI_API_KEY', overrides.geminiApiKey).catch(() => {});
  if (overrides.account) db.setSetting('SPEEDAF_ACCOUNT', overrides.account).catch(() => {});
  if (overrides.password) db.setSetting('SPEEDAF_PASSWORD', overrides.password).catch(() => {});

  console.log(`[Speedaf/AutoLogin] Starting auto-login for account: ${account}...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log('[Speedaf/AutoLogin] Waiting 2.5s before retry...');
        await new Promise(r => setTimeout(r, 2500));
      }
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

const EGYPT_GOVERNORATES_FALLBACK = [
  { code: 'EGR00160', name: 'Alexandria', nameAr: 'الإسكندرية' },
  { code: 'EGR00161', name: 'Aswan', nameAr: 'أسوان' },
  { code: 'EGR00162', name: 'Asyut', nameAr: 'أسيوط' },
  { code: 'EGR00163', name: 'Behira', nameAr: 'البحيرة' },
  { code: 'EGR00164', name: 'Beni sueif', nameAr: 'بني سويف' },
  { code: 'EGR00165', name: 'Cairo', nameAr: 'القاهرة' },
  { code: 'EGR00166', name: 'Dakahlia', nameAr: 'الدقهلية' },
  { code: 'EGR00167', name: 'Damietta', nameAr: 'دمياط' },
  { code: 'EGR00168', name: 'Faiyum', nameAr: 'الفيوم' },
  { code: 'EGR00169', name: 'Gharbia', nameAr: 'الغربية' },
  { code: 'EGR00170', name: 'Giza', nameAr: 'الجيزة' },
  { code: 'EGR00171', name: 'Hurghada', nameAr: 'البحر الأحمر' },
  { code: 'EGR00172', name: 'Ismailia', nameAr: 'الإسماعيلية' },
  { code: 'EGR00173', name: 'Kafer El Shikh', nameAr: 'كفر الشيخ' },
  { code: 'EGR00174', name: 'Luxor', nameAr: 'الأقصر' },
  { code: 'EGR00175', name: 'Matrouh', nameAr: 'مطروح' },
  { code: 'EGR00176', name: 'Menya', nameAr: 'المنيا' },
  { code: 'EGR00177', name: 'Monufia', nameAr: 'المنوفية' },
  { code: 'EGR00178', name: 'New Valley', nameAr: 'الوادي الجديد' },
  { code: 'EGR00179', name: 'Port said', nameAr: 'بورسعيد' },
  { code: 'EGR00180', name: 'Qalyubiyya', nameAr: 'القليوبية' },
  { code: 'EGR00181', name: 'Qena', nameAr: 'قنا' },
  { code: 'EGR00182', name: 'Sharqia', nameAr: 'الشرقية' },
  { code: 'EGR00183', name: 'Sohag', nameAr: 'سوهاج' },
  { code: 'EGR00184', name: 'South Sinai', nameAr: 'جنوب سيناء' },
  { code: 'EGR00185', name: 'Suez', nameAr: 'السويس' },
];

const GOV_AR_NAMES = {
  'EGR00160': 'الإسكندرية',
  'EGR00161': 'أسوان',
  'EGR00162': 'أسيوط',
  'EGR00163': 'البحيرة',
  'EGR00164': 'بني سويف',
  'EGR00165': 'القاهرة',
  'EGR00166': 'الدقهلية',
  'EGR00167': 'دمياط',
  'EGR00168': 'الفيوم',
  'EGR00169': 'الغربية',
  'EGR00170': 'الجيزة',
  'EGR00171': 'البحر الأحمر',
  'EGR00172': 'الإسماعيلية',
  'EGR00173': 'كفر الشيخ',
  'EGR00174': 'الأقصر',
  'EGR00175': 'مطروح',
  'EGR00176': 'المنيا',
  'EGR00177': 'المنوفية',
  'EGR00178': 'الوادي الجديد',
  'EGR00179': 'بورسعيد',
  'EGR00180': 'القليوبية',
  'EGR00181': 'قنا',
  'EGR00182': 'الشرقية',
  'EGR00183': 'سوهاج',
  'EGR00184': 'جنوب سيناء',
  'EGR00185': 'السويس',
};

async function fetchSpeedafAreas(parentCode = 'EG', type = 1) {
  const result = await speedafRequest('GET', '/common/area/listAreaByCountryCode?countryCode=EG');
  if (result.success && Array.isArray(result.data?.data) && result.data.data.length > 0) {
    return { success: true, areas: result.data.data };
  }
  return { success: false, areas: [], error: result.error || 'No areas returned' };
}

/**
 * مزامنة كل أكواد المحافظات والمناطق من Speedaf وتخزينها في DB
 */
async function syncAllAreas() {
  console.log('[Speedaf] 🔄 Starting full area sync from Speedaf Direct API...');
  let totalSynced = 0;

  const result = await speedafRequest('GET', '/common/area/listAreaByCountryCode?countryCode=EG');
  const allAreas = result.success && Array.isArray(result.data?.data) ? result.data.data : [];

  // Clear existing
  await db.clearAreas().catch(() => {});

  // 1. Save all 27 provinces
  for (const g of EGYPT_GOVERNORATES_FALLBACK) {
    await db.upsertAreaCode({
      code: g.code,
      name: g.name,
      nameAr: g.nameAr,
      parentCode: 'EG',
      level: 'province',
      fullPath: g.nameAr,
    });
    totalSynced++;
  }

  // 2. Save all individual areas/districts
  if (allAreas.length > 0) {
    for (const item of allAreas) {
      const pCode = item.provinceCode;
      const pNameAr = GOV_AR_NAMES[pCode] || item.provinceName || 'مصر';
      const areaAr = item.arName || item.name;

      await db.upsertAreaCode({
        code: item.code,
        name: item.name || item.enName || item.arName,
        nameAr: areaAr,
        parentCode: pCode,
        level: 'area',
        fullPath: `${pNameAr} > ${item.cityName || ''} > ${areaAr}`,
        cityCode: item.cityCode || null,
        cityName: item.cityName || null,
        provinceCode: item.provinceCode || null,
        provinceName: item.provinceName || null,
      });
      totalSynced++;
    }
    console.log(`[Speedaf] 🎉 Synced ${totalSynced} Egyptian provinces & areas successfully!`);
  } else {
    console.log(`[Speedaf] ⚠️ Using fallback governorates list (synced ${totalSynced})`);
  }

  return { success: true, synced: totalSynced };
}

/**
 * مطابقة اسم المحافظة أو المنطقة من العنوان مع كود Speedaf
 * يدعم عناوين Easy Orders بصيغة: "الشارع - المدينة - المحافظة"
 */
async function matchGovernorateToSpeedafCode(addressText) {
  if (!addressText) return null;
  const clean = addressText.trim();

  // Split address by common separators (Easy Orders sends "Street - City - Governorate")
  const parts = clean.split(/[-–,،\n]/).map(s => s.trim()).filter(Boolean);

  // Try each part from last to first (governorate is usually last)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    // Try DB search
    const dbMatch = await db.searchAreas(part, 'province');
    if (dbMatch.length > 0) return dbMatch[0];
    // Try fallback list
    for (const g of EGYPT_GOVERNORATES_FALLBACK) {
      if (part === g.nameAr || part.toLowerCase() === g.name.toLowerCase()) {
        return { code: g.code, name: g.name, name_ar: g.nameAr };
      }
    }
  }

  // Wider scan: look for any governorate keyword anywhere in the text
  for (const g of EGYPT_GOVERNORATES_FALLBACK) {
    if (clean.includes(g.nameAr) || clean.toLowerCase().includes(g.name.toLowerCase())) {
      return { code: g.code, name: g.name, name_ar: g.nameAr };
    }
  }

  return null;
}

/**
 * استخراج اسم المدينة/المنطقة من عنوان إيزي أوردرز
 * الصيغة: "الشارع - المدينة - المحافظة" → المدينة هي العنصر قبل الأخير
 */
function extractCityFromAddress(addressText) {
  if (!addressText) return '';
  const parts = addressText.split(/[-–,،\n]/).map(s => s.trim()).filter(Boolean);
  // If we have at least 2 parts, the city is likely the second-to-last element
  if (parts.length >= 2) return parts[parts.length - 2];
  return '';
}

/**
 * مطابقة المنطقة الذكية بالذكاء الاصطناعي (Gemini)
 * تحلل العنوان وتطابقه مع القائمة الرسمية لمناطق المحافظة في Speedaf
 */
async function matchAreaWithGemini({ address, provinceCode, provinceName = '' }) {
  if (!address || !provinceCode) return null;
  const cleanAddr = address.trim();
  const cityHint = extractCityFromAddress(address); // e.g. "El-Senbellawein" or "السنبلاوين"

  // 1. Get official areas for this province
  const areas = await db.getSpeedafAreasByProvince(provinceCode);
  if (!areas || areas.length === 0) return null;

  // 2. Fast direct match — check Arabic name, English name, AND extracted city part
  for (const a of areas) {
    const aNameAr = (a.name_ar || '').trim();
    const aNameEn = (a.name || '').replace(/-/g, '').toLowerCase();
    const cityHintClean = cityHint.replace(/-/g, '').toLowerCase();
    if (
      (aNameAr && (cleanAddr.includes(aNameAr) || cityHint.includes(aNameAr))) ||
      (aNameEn && (cityHintClean === aNameEn || cityHintClean.includes(aNameEn) || aNameEn.includes(cityHintClean)))
    ) {
      console.log(`[Speedaf/Match] ✅ Direct matched "${cityHint}" → "${a.name_ar}" (${a.code})`);
      return { matched: a, method: 'direct' };
    }
  }

  // 3. Smart Gemini AI Matching
  const geminiKey = await getSetting('GEMINI_API_KEY');
  if (!geminiKey) return null;

  const areaNames = areas.map(a => a.name_ar || a.name);
  const pName = provinceName || (await db.getAreaByCode(provinceCode))?.name_ar || 'المحافظة';

  const prompt = `أنت خبير في الجغرافيا والمناطق والمراكز والأحياء المصرية.
لدينا عنوان عميل مصري في محافظة "${pName}":
"${cleanAddr}"

اختر أدق منطقة أو مركز أو حي يتبع له هذا العنوان من القائمة الرسمية المعتمدة التالية فقط:
[${areaNames.join(', ')}]

أجب باسم المنطقة فقط تماماً كما هو مكتوب في القائمة، بدون أي كلمات إضافية أو علامات ترقيم.`;

  const models = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
      };

      const res = await httpPost(url, payload, { 'x-goog-api-key': geminiKey });
      if (res.status === 200 && res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const reply = res.data.candidates[0].content.parts[0].text.trim();
        const found = areas.find(a => {
          const aName = a.name_ar || a.name;
          return aName === reply || reply.includes(aName) || aName.includes(reply);
        });
        if (found) {
          console.log(`[Speedaf/SmartMatch] 🤖 Gemini (${model}) matched "${cleanAddr}" → "${found.name_ar}" (${found.code})`);
          return { matched: found, method: 'gemini', model };
        }
      }
    } catch (e) {
      console.warn(`[Speedaf/SmartMatch] Model ${model} failed:`, e.message);
    }
  }

  return null;
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

  if (!locationCodes || (!locationCodes.provinceCode && !locationCodes.districtCode)) {
    return { success: false, error: 'أكواد المنطقة مطلوبة — اختار المحافظة والمدينة والحي' };
  }

  // Simulated order bypass
  if (order.order_number && String(order.order_number).startsWith('#SIM-')) {
    console.log('[Speedaf] ⚠️ Simulated order — faking success');
    return { success: true, message: 'Simulated success', waybillNo: 'SIM-WAYBILL-001' };
  }

  try {
    // 1. Resolve Location Codes (Province, City, District)
    let provinceCode = locationCodes.provinceCode || '';
    let provinceName = locationCodes.provinceName || '';
    let cityCode = locationCodes.cityCode || '';
    let cityName = locationCodes.cityName || '';
    let districtCode = locationCodes.districtCode || '';
    let districtName = locationCodes.districtName || '';

    // If districtCode is present, look up the exact official Speedaf city & province
    if (districtCode) {
      try {
        const dbArea = await db.getAreaByCode(districtCode);
        if (dbArea) {
          if (dbArea.city_code) cityCode = dbArea.city_code;
          if (dbArea.city_name) cityName = dbArea.city_name;
          if (dbArea.province_code) provinceCode = dbArea.province_code;
          if (dbArea.province_name) provinceName = dbArea.province_name;
          districtName = dbArea.name_ar || dbArea.name || districtName;
        }
      } catch (e) {}

      // Fallback: If cityCode is still missing or wrongly passed as district code, query live areas
      if (!cityCode || cityCode.startsWith('EGA')) {
        try {
          const areaListRes = await fetchSpeedafAreas();
          const liveArea = (areaListRes.areas || []).find(a => a.code === districtCode);
          if (liveArea) {
            cityCode = liveArea.cityCode || cityCode;
            cityName = liveArea.cityName || cityName;
            provinceCode = liveArea.provinceCode || provinceCode;
            provinceName = liveArea.provinceName || provinceName;
            districtName = liveArea.arName || liveArea.name || districtName;
          }
        } catch (e) {}
      }
    }

    // Ensure provinceName in English matches Speedaf expectations if known
    if (provinceCode && !provinceName) {
      const fallbackGov = EGYPT_GOVERNORATES_FALLBACK.find(g => g.code === provinceCode);
      if (fallbackGov) provinceName = fallbackGov.name;
    }

    // 2. Parse products / items
    let items = [];
    try { items = JSON.parse(order.items || '[]'); } catch {}
    
    // Clean goods name: remove promotional subtitles after '|' or ' - '
    let goodsName = items.map(i => {
      const raw = i.name || i.title || 'منتج';
      return raw.split('|')[0].trim();
    }).join(', ').substring(0, 100) || 'منتج';
    const goodsQTY = items.reduce((sum, i) => sum + (i.quantity || 1), 0) || 1;

    // 3. Parse recipient information
    let address = order.address || '';
    let customerName = order.customer_name || 'عميل';
    let customerPhone = (order.customer_phone || '').replace(/^\+/, '').replace(/^002/, '2').replace(/^20/, '0');
    if (/^01\d{9}$/.test(customerPhone)) {
      // Clean Egyptian local phone format (01xxxxxxxxx)
    } else if (order.customer_phone) {
      customerPhone = order.customer_phone.replace(/^\+/, '');
    }

    // Extract from raw_payload if available
    let rawPayload = {};
    try { rawPayload = JSON.parse(order.raw_payload || '{}'); } catch {}
    if (rawPayload.shipping_address) {
      const sa = rawPayload.shipping_address;
      if (!address) {
        address = [sa.address1, sa.address2].filter(Boolean).join(', ');
      }
      if (!customerPhone) {
        customerPhone = (sa.phone || rawPayload.customer?.phone || '').replace(/^\+/, '');
      }
    }

    // 4. Clean street address: strip out redundant governorate names from the street field
    let cleanAddress = address;
    const govAr = GOV_AR_NAMES[provinceCode];
    const namesToStrip = [provinceName, govAr, cityName, districtName].filter(Boolean);
    for (const n of namesToStrip) {
      if (n.length >= 3) {
        cleanAddress = cleanAddress.replace(new RegExp(`^${n}\\s*[-–,،/]\\s*`, 'i'), '');
        cleanAddress = cleanAddress.replace(new RegExp(`\\s*[-–,،/]\\s*${n}$`, 'i'), '');
      }
    }
    cleanAddress = cleanAddress.trim();
    if (!cleanAddress) cleanAddress = address;

    // 5. COD Amount
    const codFee = parseFloat(order.total) || 0;

    // 6. Sender defaults
    const sender = await getSenderDefaults();

    // 7. Options: Allow Open Package
    const allowOpenSetting = await getSetting('SPEEDAF_ALLOW_OPEN');
    const isAllowOpen = allowOpenSetting === 'true' || allowOpenSetting === '1' ? 1 : 0;

    // Build finalized Speedaf payload
    const payload = {
      // Recipient (المستلم)
      acceptName: customerName,
      acceptMobile: customerPhone,
      acceptAddress: cleanAddress,
      acceptCountryCode: 'EG',
      acceptCountryName: 'Egypt',
      acceptProvinceCode: provinceCode,
      acceptProvinceName: provinceName || '',
      acceptCityCode: cityCode || '',
      acceptCityName: cityName || '',
      acceptDistrictCode: districtCode || '',
      acceptDistrictName: districtName || '',
      acceptEmail: '',

      // Sender (المرسل)
      ...sender,

      // Shipment details
      goodsName,
      goodsQTY,
      goodsWeight: 1,
      goodsType: 'IT01',
      goodsTypeName: 'Normal',
      codFee,
      paymentMethod: 'PA02',  // Cash on delivery
      isAllowOpen,
      insurePrice: 0,
      shippingFee: 0,
      deliveryType: '',
      customOrderNo: order.order_number || '',
      remark: `Order ${order.order_number || ''}`.trim(),
    };

    console.log(`[Speedaf] 📦 Creating shipment for ${order.order_number}: Prov: [${provinceName} (${provinceCode})], City: [${cityName} (${cityCode})], Dist: [${districtName} (${districtCode})], Street: "${cleanAddress}"`);

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
  speedafRequest,
  // Area codes
  fetchSpeedafAreas,
  syncAllAreas,
  matchGovernorateToSpeedafCode,
  matchAreaWithGemini,
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

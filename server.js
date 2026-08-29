'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const db = require('./database/db');

// Load DB settings into process.env
async function loadSettingsFromDb() {
  try {
    const settings = await db.getSettings();
    for (const { key, value } of settings) {
      if (key === 'WHATSAPP_MESSAGE_IMAGE_BASE64') continue; // كبيرة، اتقرأ من DB مباشرة وقت الإرسال
      if (value) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[Server] Could not load settings from DB:', err.message);
  }
}

const app = express();

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.url && req.url.startsWith('/webhook/shopify')) {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Helper to parse cookies
function parseCookies(cookieStr) {
  return (cookieStr || '').split(';').reduce((acc, str) => {
    const [k, v] = str.split('=').map(s => s.trim());
    if (k) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

// ─── Password hashing ─────────────────────────────────────────────────────────
// Uses Node's built-in crypto.scrypt (no extra native dependency — avoids
// repeating the libatomic1/native-module build issue from before). Each
// user gets a random salt so two identical passwords never produce the
// same stored hash.
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, storedHash) {
  const hash = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
// Sessions live in the DB (not a single in-memory token) so:
//  1. Each logged-in person gets their OWN session, independent of others.
//  2. Sessions survive server restarts/redeploys — people don't get logged
//     out every time the app redeploys.
//  3. Deactivating a user immediately deletes their session rows, revoking
//     access right away instead of waiting for a token to "expire".
async function createSessionCookie(res, userId, username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession(token, userId, username, role);
  res.setHeader('Set-Cookie', `dopa_auth=${token}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
}

// ─── Basic login rate limiting ───────────────────────────────────────────────
// Protects against brute-forcing passwords. Keyed by IP, resets after
// a successful login or after the window expires.
const loginAttempts = new Map(); // ip -> { count, firstAttempt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count++;
  }
}

// Periodically sweep stale entries from loginAttempts so the Map doesn't
// grow unbounded on a long-running server (each unique IP that ever hit
// the login page would otherwise stay forever).
setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [ip, entry] of loginAttempts) {
    if (entry.firstAttempt < cutoff) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000); // every hour


// ─── Owner (admin) login — unchanged password, now issues a DB session ──────
app.post('/api/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'محاولات كتير خاطئة — حاول بعد 10 دقايق' });
  }

  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD || (await db.getSetting('DASHBOARD_PASSWORD').catch(() => null)) || 'admin123';

  if (password === adminPass) {
    loginAttempts.delete(ip);
    try {
      await createSessionCookie(res, null, 'admin', 'admin');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  } else {
    recordFailedAttempt(ip);
    res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة' });
  }
});

// ─── Member signup — creates a 'pending' account, must be approved ──────────
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !username.trim() || !password) {
      return res.status(400).json({ success: false, error: 'اكتب اسم المستخدم وكلمة المرور' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'كلمة المرور لازم تكون 6 حروف/أرقام على الأقل' });
    }
    const cleanUsername = username.trim().toLowerCase();
    const existing = await db.getUserByUsername(cleanUsername);
    if (existing) {
      return res.status(400).json({ success: false, error: 'اسم المستخدم ده مستخدم بالفعل' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    await db.createUser(cleanUsername, hash, salt);
    res.json({ success: true, message: 'تم إرسال طلبك — استنى موافقة الأدمن عشان تقدر تسجل دخول' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Member login — only 'active' accounts can log in ───────────────────────
app.post('/api/member-login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'محاولات كتير خاطئة — حاول بعد 10 دقايق' });
  }

  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'اكتب اسم المستخدم وكلمة المرور' });
    }
    const user = await db.getUserByUsername(username.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      recordFailedAttempt(ip);
      return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: user.status === 'pending' ? 'حسابك لسه في انتظار موافقة الأدمن' : 'حسابك موقوف — تواصل مع الأدمن',
      });
    }
    loginAttempts.delete(ip);
    await createSessionCookie(res, user.id, user.username, 'member');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.dopa_auth) await db.deleteSessionByToken(cookies.dopa_auth);
  } catch (e) { /* ignore */ }
  res.setHeader('Set-Cookie', 'dopa_auth=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// Auth Middleware — now checks the DB-backed sessions table (async), since
// sessions are no longer a single shared in-memory token.
app.use(async (req, res, next) => {
  // Public routes that never require auth
  const publicPaths = ['/api/login', '/api/signup', '/api/member-login'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/webhook')) {
    return next();
  }

  // Allow static assets (css, js, images) but protect HTML pages
  if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico)$/)) {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  let session = null;
  if (cookies.dopa_auth) {
    try { session = await db.getSession(cookies.dopa_auth); } catch (e) { session = null; }
  }
  const isAuthenticated = !!session;
  if (session) {
    req.userRole = session.role;
    req.username = session.username;
  }

  // If going to login/signup pages
  if (req.path === '/login.html' || req.path === '/signup.html') {
    if (isAuthenticated) {
      return res.redirect('/');
    } else {
      return next(); // Let them see the page
    }
  }

  // For any other protected route
  if (!isAuthenticated) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    } else {
      return res.redirect('/login.html');
    }
  }

  next();
});

// ─── User management (admin-only — req.userRole is set by the auth
// middleware above, so this MUST be registered after it) ───────────────────
app.get('/api/users', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ success: false, error: 'للأدمن فقط' });
  try {
    const users = await db.getAllUsers();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users/:id/approve', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ success: false, error: 'للأدمن فقط' });
  try {
    await db.setUserStatus(req.params.id, 'active');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users/:id/reject', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ success: false, error: 'للأدمن فقط' });
  try {
    await db.setUserStatus(req.params.id, 'rejected');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users/:id/suspend', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ success: false, error: 'للأدمن فقط' });
  try {
    await db.setUserStatus(req.params.id, 'suspended');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  const start = Date.now();
  // Capture the full path NOW, before Express mutates req.url/req.path
  // while dispatching into a mounted sub-router (e.g. '/api/orders').
  // Route handlers that end the response with res.json() without calling
  // next() never trigger Express's URL-restore step, so by the time the
  // res.on('finish') callback below runs, req.path would show the path
  // WITH the mount prefix stripped (e.g. "/quick-links" instead of
  // "/api/orders/quick-links") — very confusing when debugging logs.
  const fullPath = req.originalUrl || req.path;
  res.on('finish', () => {
    const duration = Date.now() - start;
    const color = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
    console.log(`${color}[${new Date().toISOString()}] ${req.method} ${fullPath} → ${res.statusCode} (${duration}ms)\x1b[0m`);
  });
  next();
});

app.use('/webhook', require('./routes/webhook'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/workspace', require('./routes/workspace'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/test', require('./routes/test'));

// SSE for real-time dashboard updates
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

global.broadcastSSE = (data) => {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/workspace', (req, res) => res.sendFile(path.join(__dirname, 'public', 'workspace.html')));
app.get('/notes',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'notes.html')));

// ─── Dynamic favicon ──────────────────────────────────────────────────────────
// Served from the DB setting so the merchant can upload/change it from
// Settings without touching any files or redeploying.
app.get('/favicon.ico', async (req, res) => {
  try {
    const base64 = await db.getSetting('SITE_FAVICON_BASE64');
    if (!base64) return res.status(404).end();
    const buffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (e) {
    res.status(404).end();
  }
});

app.get('/health', async (req, res) => {
  const stats = await db.getOrderStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    stats,
    env: {
      shopify_store: process.env.SHOPIFY_STORE || 'not set',
      green_api_instance: process.env.GREEN_API_INSTANCE_ID || 'not set',
      starlink_url: process.env.STARLINK_API_URL ? 'configured' : 'not set',
      turso: process.env.TURSO_DATABASE_URL ? 'configured' : 'NOT SET ⚠️',
    },
  });
});

app.get('/api/whatsapp/status', (req, res) => {
  const baileysClient = require('./services/baileys_client');
  res.json(baileysClient.getConnectionStatus());
});

app.post('/api/whatsapp/logout', async (req, res) => {
  const baileysClient = require('./services/baileys_client');
  // Respond first so the client doesn't hang waiting for Baileys to reconnect
  res.json({ success: true });
  try {
    await baileysClient.logoutBaileys();
  } catch (e) {
    console.error('[server] logoutBaileys error:', e.message);
  }
});

// Hard-reset: حذف الـ session من DB مباشرة وإعادة تشغيل Baileys من الصفر
// بيشتغل حتى لو الـ socket مش متصل أو عالق في reconnecting
app.post('/api/whatsapp/reset', async (req, res) => {
  const baileysClient = require('./services/baileys_client');
  res.json({ success: true, message: 'Resetting WhatsApp session...' });
  try {
    await baileysClient.logoutBaileys();
  } catch (e) {
    // Even if logout fails, try force reset
    try {
      const db = require('./database/db');
      await db.getDb().execute('DELETE FROM whatsapp_auth');
      console.log('[server] Force-cleared whatsapp_auth table');
      await baileysClient.startBaileys();
    } catch (e2) {
      console.error('[server] Hard reset error:', e2.message);
    }
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const PORT = parseInt(process.env.PORT) || 3000;

async function startServer() {
  // Init DB schema + load settings before listening
  // (await the REAL completion of schema creation, not a guessed delay —
  // a fixed setTimeout could resolve before the "CREATE TABLE" calls actually
  // finish on a slow/cold Turso connection, causing queries like
  // "SELECT * FROM quick_links" to fail with "no such table" right after boot)
  await db.ready();
  await loadSettingsFromDb();

  const baileysClient = require('./services/baileys_client');
  const webhook = require('./routes/webhook');
  baileysClient.setMessageHandler(webhook.processIncomingWhatsAppMessage);
  baileysClient.startBaileys().catch(e => console.error('[Baileys] Error starting:', e));

  app.listen(PORT, '0.0.0.0', async () => {
    console.log('\x1b[36m');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║          DopaConfirm Server Started        ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`\x1b[0m`);
    console.log(`🚀 Server running at: \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`📦 Database: Turso (${process.env.TURSO_DATABASE_URL || 'NOT SET'})`);

    const { getProvider } = require('./services/whatsapp');
    const provider = await getProvider();
    let webhookBase = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`;
    if (webhookBase && !webhookBase.startsWith('http')) {
      webhookBase = `https://${webhookBase}`;
    }
    console.log(`📱 WhatsApp Provider: ${provider.toUpperCase()}`);

    if (provider === 'meta') {
      const metaPhoneId = process.env.META_PHONE_NUMBER_ID;
      const metaToken   = process.env.META_ACCESS_TOKEN;
      if (metaPhoneId && metaToken) {
        console.log(`✅ Meta API configured — Phone ID: ${metaPhoneId}`);
        console.log(`🔗 Meta Webhook URL: ${webhookBase}/webhook/meta`);
        console.log(`🔑 Meta Verify Token: ${process.env.META_WEBHOOK_VERIFY_TOKEN || 'dopaconfirm_verify'}`);
        console.log('   → Set these in Meta Developer Console → WhatsApp → Configuration → Webhooks');
      } else {
        console.warn('⚠️  META_PHONE_NUMBER_ID or META_ACCESS_TOKEN not set');
      }
    } else if (provider === 'green') {
      const instanceId = process.env.GREEN_API_INSTANCE_ID;
      const token = process.env.GREEN_API_TOKEN;
      if (instanceId && token) {
        const { registerWebhook } = require('./services/whatsapp');
        const whatsappWebhookUrl = `${webhookBase}/webhook/whatsapp`;
        const result = await registerWebhook(whatsappWebhookUrl);
        if (result.success) {
          console.log(`✅ Green API webhook registered: ${whatsappWebhookUrl}`);
        } else {
          console.warn(`⚠️  Green API webhook registration failed: ${result.error}`);
        }
      } else {
        console.warn('⚠️  GREEN_API_INSTANCE_ID or GREEN_API_TOKEN not set');
      }
    } else {
      console.log('   → Using INTERNAL (Baileys) — no external webhook registration needed.');
    }

    // Background job: abandoned carts every 5 minutes
    setInterval(async () => {
      try {
        const pendingCheckouts = await db.getPendingAbandonedCheckouts();
        if (pendingCheckouts.length > 0) {
          const { sendAbandonedCheckoutRecovery } = require('./services/whatsapp');
          for (const checkout of pendingCheckouts) {
            const order = await db.getOrderByPhone(checkout.customer_phone);
            if (order) { await db.markCheckoutRecoverySent(checkout.checkout_token); continue; }
            const res = await sendAbandonedCheckoutRecovery(checkout);
            if (res.success) await db.markCheckoutRecoverySent(checkout.checkout_token);
          }
        }
      } catch (err) {
        console.error('[Background] Error processing abandoned carts:', err);
      }
    }, 5 * 60 * 1000);

    // ─── Background Jobs (Auto-Retry, Order Timeout, Daily Report) ──────────
    const { startBackgroundJobs } = require('./services/backgroundJobs');
    startBackgroundJobs();
  });
}

startServer();

process.on('unhandledRejection', (reason) => console.error('[Server] Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => { console.error('[Server] Uncaught Exception:', err); process.exit(1); });

module.exports = app;

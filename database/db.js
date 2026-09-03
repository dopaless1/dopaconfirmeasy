'use strict';

/**
 * Database layer using Turso (libSQL) — cloud SQLite.
 * Replaces the local node:sqlite module for cloud deployment.
 * Uses @libsql/client package.
 */

const { createClient } = require('@libsql/client');

let db;
let schemaReadyPromise = null;

// getDb() ONLY ensures the connection object exists — it must NEVER also
// trigger schema initialization. initializeSchema() itself calls getDb()
// internally to run its CREATE TABLE statements; if getDb() also kicked off
// initializeSchema() (as a previous version of this file did), the very
// first call chain becomes:
//   getDb() -> schemaReadyPromise is still null (assignment hasn't
//   finished yet) -> initializeSchema() -> getDb() -> schemaReadyPromise
//   STILL null -> initializeSchema() -> getDb() -> ... forever,
// a synchronous infinite loop that crashes the process with
// "Maximum call stack size exceeded" before a single query ever runs.
// Keeping getDb() schema-agnostic breaks that cycle for good.
function getDb() {
  if (!db) {
    db = createClient({
      url: process.env.TURSO_DATABASE_URL || 'file:local.db',
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return db;
}

// Ensures the DB connection exists AND the schema has finished being created
// before any query runs. Fixes a race where the very first query after a
// cold start (e.g. GET /quick-links) executed before CREATE TABLE finished.
//
// If initializeSchema() ever rejects (e.g. a transient network blip with
// Turso during a cold start), schemaReadyPromise is reset to null so the
// NEXT caller retries from scratch instead of every future call instantly
// re-throwing the same cached, permanently-stale error.
async function ready() {
  getDb();
  if (!schemaReadyPromise) {
    schemaReadyPromise = initializeSchema().catch(err => {
      console.error('[DB] Schema init error (will retry on next call):', err.message);
      schemaReadyPromise = null;
      throw err;
    });
  }
  await schemaReadyPromise;
  return db;
}

async function initializeSchema() {
  const client = getDb();

  // Run each table creation separately for Turso compatibility
  await client.execute(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id TEXT UNIQUE NOT NULL,
      order_number TEXT NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      items TEXT,
      total TEXT,
      address TEXT,
      status TEXT DEFAULT 'pending_confirmation',
      whatsapp_sent_at TEXT,
      customer_reply TEXT,
      replied_at TEXT,
      shipping_sent_at TEXT,
      raw_payload TEXT,
      review_sent_at TEXT,
      rating INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS whatsapp_auth (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      phone TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS whatsapp_polls (
      id TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS abandoned_checkouts (
      checkout_token TEXT PRIMARY KEY,
      customer_name TEXT,
      customer_phone TEXT,
      total TEXT,
      checkout_url TEXT,
      recovery_sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS quick_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  // Workers (employees/helpers) — each has a WhatsApp phone number so
  // task reminders can be sent directly to the person responsible,
  // not just the shared owner alert number.
  await client.execute(`CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  // Tasks live in the DB (not localStorage) so a server-side background
  // job can check due dates and send WhatsApp reminders even if nobody
  // has the dashboard open in a browser tab.
  await client.execute(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      priority TEXT DEFAULT 'med',
      due_date TEXT,
      assignee_worker_ids TEXT,
      done INTEGER DEFAULT 0,
      reminder_sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);

  // ─── Multi-user accounts ────────────────────────────────────────────────
  // Anyone can sign up, but new accounts sit as 'pending' until the owner
  // (admin) approves them from the dashboard — nobody can log in with a
  // pending or rejected account.
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  // Sessions are stored in the DB (not just an in-memory token) so logging
  // in survives server restarts/redeploys, and so a deactivated user's
  // session can be revoked immediately by deleting their row here.
  await client.execute(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);

  // ─── Suppliers (moved from browser localStorage to the server) ─────────
  // Previously stored per-device in localStorage, meaning each person using
  // the dashboard saw different data. Now shared across everyone.
  await client.execute(`CREATE TABLE IF NOT EXISTS supplier_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      product TEXT,
      phone TEXT,
      price TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);

  // ─── Notes (moved from browser localStorage to the server) ─────────────
  await client.execute(`CREATE TABLE IF NOT EXISTS note_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  await client.execute(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER,
      title TEXT,
      content TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );`);

  await client.execute(`CREATE TABLE IF NOT EXISTS speedaf_area_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      name_ar TEXT,
      parent_code TEXT,
      level TEXT NOT NULL,
      full_path TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );`);

  // Defensive: "CREATE TABLE IF NOT EXISTS" is a no-op if the table already
  // exists from an older deploy that had a different column set. If a
  // previous version of quick_links was created WITHOUT sort_order, every
  // query ordering by it would fail with "no such column: sort_order".
  // ALTER TABLE ADD COLUMN is safe to attempt repeatedly — SQLite/Turso
  // throws (harmlessly, caught below) if the column already exists.
  try {
    await client.execute('ALTER TABLE quick_links ADD COLUMN sort_order INTEGER DEFAULT 0');
  } catch (e) {
    // Column already exists — expected on every boot after the first migration
  }

  // Soft-delete support ("trash bin"): deleted orders are hidden from the
  // dashboard via deleted_at instead of being permanently removed, so they
  // can be restored later if needed.
  try {
    await client.execute('ALTER TABLE orders ADD COLUMN deleted_at TEXT');
  } catch (e) {
    // Column already exists
  }


  try {
    await client.execute('ALTER TABLE orders ADD COLUMN notes TEXT');
  } catch (e) {
    // Ignore if column already exists
  }

  try {
    await client.execute('ALTER TABLE orders ADD COLUMN handed_to_courier_at TEXT');
  } catch (e) {
    // Ignore if column already exists
  }

  try {
    // Personal packing-checklist marker — independent of the main status
    // flow, just so the merchant doesn't lose track of what's packed.
    await client.execute('ALTER TABLE orders ADD COLUMN prepared_at TEXT');
  } catch (e) {
    // Ignore if column already exists
  }

  try { await client.execute('ALTER TABLE orders ADD COLUMN source TEXT DEFAULT \'shopify\''); } catch (e) {}
  try { await client.execute('ALTER TABLE orders ADD COLUMN easyorders_id TEXT'); } catch (e) {}
  try { await client.execute('ALTER TABLE orders ADD COLUMN speedaf_waybill TEXT'); } catch (e) {}
  try { await client.execute('ALTER TABLE orders ADD COLUMN speedaf_status TEXT'); } catch (e) {}
  try { await client.execute('ALTER TABLE orders ADD COLUMN speedaf_status_updated_at TEXT'); } catch (e) {}

  // Performance: index on status so background-job queries (WHERE status = 'whatsapp_failed')
  // don't do a full table scan as the orders table grows.
  try {
    await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
    await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at)');
    await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)');
  } catch (e) {
    // Ignore if indexes already exist
  }

  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_area_codes_parent ON speedaf_area_codes(parent_code)'); } catch (e) {}
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_area_codes_level ON speedaf_area_codes(level)'); } catch (e) {}
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source)'); } catch (e) {}
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_orders_speedaf_waybill ON orders(speedaf_waybill)'); } catch (e) {}

  // Auto-repair any malformed Easy Orders order numbers from previous versions
  try {
    await client.execute("UPDATE orders SET order_number = REPLACE(order_number, 'EO-#', '#EO-') WHERE order_number LIKE 'EO-#%'");
    await client.execute("UPDATE orders SET order_number = REPLACE(order_number, '#EO-#', '#EO-') WHERE order_number LIKE '#EO-#%'");
  } catch (e) {}

  // WhatsApp LID (Linked ID / Username / Privacy) to Phone Number Mapping
  await client.execute(`CREATE TABLE IF NOT EXISTS whatsapp_lid_mapping (
      lid TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  try { await client.execute('ALTER TABLE whatsapp_polls ADD COLUMN order_id TEXT'); } catch (e) {}
  try { await client.execute('ALTER TABLE whatsapp_polls ADD COLUMN phone TEXT'); } catch (e) {}
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function normalizePhoneForLookup(phone) {
  if (!phone) return '';
  let p = phone
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '')
    .replace(/^\+/, '')
    .trim();
  if (/^01\d{9}$/.test(p)) {
    p = '20' + p.slice(1);
  }
  return p;
}

// ─── Orders ────────────────────────────────────────────────────────────────

async function insertOrder(order) {
  const client = getDb();
  const res = await client.execute({
    sql: `INSERT OR IGNORE INTO orders
      (shopify_order_id, order_number, customer_name, customer_phone, items, total, address, status, raw_payload, source, easyorders_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      String(order.shopify_order_id || order.id || ''),
      order.order_number || null,
      order.customer_name || null,
      order.customer_phone || null,
      order.items || '[]',
      order.total || null,
      order.address || null,
      order.status || 'pending_confirmation',
      order.raw_payload || null,
      order.source || 'shopify',
      order.easyorders_id || null,
    ],
  });
  // Turso returns rowsAffected as a number
  return { rowsAffected: res.rowsAffected ?? res.changes ?? 0 };
}

async function updateOrderDetails(order) {
  const client = getDb();
  const res = await client.execute({
    sql: `UPDATE orders SET 
      customer_name = ?, 
      customer_phone = ?, 
      items = ?, 
      total = ?, 
      address = ?, 
      raw_payload = ?,
      source = COALESCE(?, source),
      easyorders_id = COALESCE(?, easyorders_id),
      updated_at = datetime('now')
      WHERE shopify_order_id = ?`,
    args: [
      order.customer_name || null,
      order.customer_phone || null,
      order.items || '[]',
      order.total || null,
      order.address || null,
      order.raw_payload || null,
      order.source || null,
      order.easyorders_id || null,
      String(order.shopify_order_id || order.id || ''),
    ],
  });
  return { rowsAffected: res.rowsAffected ?? res.changes ?? 0 };
}

async function updateOrderStatus(shopifyOrderId, status, extra = {}) {
  const client = getDb();

  let sql = "UPDATE orders SET status = ?, updated_at = datetime('now')";
  const args = [status];

  if (extra.whatsapp_sent_at !== undefined) { sql += ', whatsapp_sent_at = ?'; args.push(extra.whatsapp_sent_at); }
  if (extra.customer_reply   !== undefined) { sql += ', customer_reply = ?';   args.push(extra.customer_reply);   }
  if (extra.replied_at       !== undefined) { sql += ', replied_at = ?';       args.push(extra.replied_at);       }
  if (extra.shipping_sent_at !== undefined) { sql += ', shipping_sent_at = ?'; args.push(extra.shipping_sent_at); }
  if (extra.handed_to_courier_at !== undefined) { sql += ', handed_to_courier_at = ?'; args.push(extra.handed_to_courier_at); }

  sql += ' WHERE shopify_order_id = ?';
  args.push(shopifyOrderId);

  return client.execute({ sql, args });
}

async function updateOrderNotes(id, notes) {
  const client = getDb();
  return client.execute({
    sql: "UPDATE orders SET notes = ?, updated_at = datetime('now') WHERE id = ?",
    args: [notes, id],
  });
}

async function toggleOrderPrepared(id, prepared) {
  const client = getDb();
  return client.execute({
    sql: "UPDATE orders SET prepared_at = ? WHERE id = ?",
    args: [prepared ? new Date().toISOString() : null, id],
  });
}

async function getOrderByShopifyId(shopifyOrderId) {
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT * FROM orders WHERE shopify_order_id = ?', args: [shopifyOrderId] });
  return res.rows[0] || null;
}

async function getOrderById(id) {
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  return res.rows[0] || null;
}

async function getOrderByPhone(phone) {
  const client = getDb();
  const normalized = normalizePhoneForLookup(phone);
  const cleanPhone1 = normalized.replace(/^20/, '0'); // e.g. 01012345678
  const cleanPhone2 = normalized; // e.g. 201012345678
  const cleanPhone3 = '+' + normalized; // e.g. +201012345678

  // Try direct match from orders table first (most reliable)
  const direct = await client.execute({
    sql: `SELECT * FROM orders
          WHERE deleted_at IS NULL
          AND status IN ('pending_confirmation', 'whatsapp_sent', 'whatsapp_failed', 'shipping_failed', 'confirmed')
          AND (
            customer_phone = ? OR
            customer_phone = ? OR
            customer_phone = ? OR
            customer_phone LIKE ?
          )
          ORDER BY created_at DESC LIMIT 1`,
    args: [cleanPhone1, cleanPhone2, cleanPhone3, `%${cleanPhone1}%`],
  });
  if (direct.rows[0]) return direct.rows[0];

  // Try sessions table join as secondary fallback
  const sessionRes = await client.execute({
    sql: `SELECT o.* FROM orders o
          INNER JOIN whatsapp_sessions ws ON (ws.order_id = o.shopify_order_id OR ws.order_id = CAST(o.id AS TEXT))
          WHERE ws.phone = ? OR ws.phone = ?
          ORDER BY o.created_at DESC LIMIT 1`,
    args: [normalized, cleanPhone1],
  });
  return sessionRes.rows[0] || null;
}

async function getLatestActiveOrderByPhone(phone) {
  return getOrderByPhone(phone);
}

async function getAllOrders(filters = {}) {
  const client = getDb();
  // Trashed orders are hidden by default so they don't clutter the normal
  // dashboard views; pass filters.includeTrashed = true to see them (used
  // only by the dedicated Trash tab).
  let sql = filters.includeTrashed ? 'SELECT * FROM orders WHERE deleted_at IS NOT NULL' : 'SELECT * FROM orders WHERE deleted_at IS NULL';
  const args = [];

  if (filters.status && filters.status !== 'all') {
    const statuses = Array.isArray(filters.status)
      ? filters.status
      : filters.status.split(',').map(s => s.trim()).filter(Boolean);

    if (statuses.length > 0 && !statuses.includes('all')) {
      const placeholders = statuses.map(() => '?').join(',');
      sql += ` AND status IN (${placeholders})`;
      args.push(...statuses);
    }
  }

  if (filters.search) {
    sql += ' AND (customer_name LIKE ? OR customer_phone LIKE ? OR order_number LIKE ?)';
    const term = `%${filters.search}%`;
    args.push(term, term, term);
  }

  if (filters.date && filters.date !== 'all') {
    if (filters.date === 'today') {
      sql += " AND DATE(created_at) >= date('now', 'localtime')";
    } else if (filters.date === 'last_1') {
      sql += " AND DATE(created_at) >= date('now', '-1 days')";
    } else if (filters.date === 'last_2') {
      sql += " AND DATE(created_at) >= date('now', '-2 days')";
    } else if (filters.date === 'last_5') {
      sql += " AND DATE(created_at) >= date('now', '-5 days')";
    } else if (filters.date === 'last_7') {
      sql += " AND DATE(created_at) >= date('now', '-7 days')";
    } else if (filters.date === 'last_30') {
      sql += " AND DATE(created_at) >= date('now', '-30 days')";
    } else if (filters.date === 'last_180') {
      sql += " AND DATE(created_at) >= date('now', '-180 days')";
    } else {
      sql += ' AND DATE(created_at) = ?';
      args.push(filters.date);
    }
  }

  if (filters.source && filters.source !== 'all' && filters.source !== 'both') {
    if (filters.source === 'easyorders') {
      sql += " AND (source = 'easyorders' OR source = 'easy_orders')";
    } else if (filters.source === 'shopify') {
      sql += " AND (source = 'shopify' OR source IS NULL OR source = '')";
    }
  }

  const sortOrder = filters.sort === 'asc' ? 'ASC' : 'DESC';
  // Sorting by actual Shopify creation time ensures correct order regardless of import batches
  sql += ` ORDER BY COALESCE(json_extract(raw_payload, '$.created_at'), created_at) ${sortOrder}`;

  if (filters.limit) {
    sql += ' LIMIT ?';
    args.push(parseInt(filters.limit));
  }

  const res = await client.execute({ sql, args });
  return res.rows;
}

// Soft delete — moves the order to "trash" instead of removing it,
// so it can be restored later if needed.
async function trashOrder(id) {
  const client = getDb();
  return client.execute({
    sql: "UPDATE orders SET deleted_at = datetime('now') WHERE id = ?",
    args: [id],
  });
}

async function restoreOrder(id) {
  const client = getDb();
  return client.execute({
    sql: 'UPDATE orders SET deleted_at = NULL WHERE id = ?',
    args: [id],
  });
}

async function permanentlyDeleteOrder(id) {
  const client = getDb();
  return client.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
}

async function getTrashedOrders() {
  const client = getDb();
  const res = await client.execute({
    sql: 'SELECT * FROM orders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    args: [],
  });
  return res.rows;
}

// Kept for internal/legacy callers that genuinely need a hard delete
// (e.g. cleaning up a duplicate created by mistake before ever showing
// in the dashboard). Prefer trashOrder() for anything user-facing.
async function deleteOrder(id) {
  const client = getDb();
  return client.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
}

async function deleteOrderByShopifyId(shopifyOrderId) {
  const client = getDb();
  return client.execute({ sql: 'DELETE FROM orders WHERE shopify_order_id = ?', args: [String(shopifyOrderId)] });
}

async function getOrderStats(filters = {}) {
  const client = getDb();
  let where = 'WHERE deleted_at IS NULL';
  const args = [];

  if (filters && filters.source && filters.source !== 'all' && filters.source !== 'both') {
    if (filters.source === 'easyorders') {
      where += " AND (source = 'easyorders' OR source = 'easy_orders')";
    } else if (filters.source === 'shopify') {
      where += " AND (source = 'shopify' OR source IS NULL OR source = '')";
    }
  }

  const res = await client.execute({
    sql: `SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status IN ('pending_confirmation','whatsapp_sent') THEN 1 ELSE 0 END),0) as pending,
      COALESCE(SUM(CASE WHEN status = 'confirmed'       THEN 1 ELSE 0 END),0) as confirmed,
      COALESCE(SUM(CASE WHEN status = 'cancelled'       THEN 1 ELSE 0 END),0) as cancelled,
      COALESCE(SUM(CASE WHEN status = 'shipping_sent'   THEN 1 ELSE 0 END),0) as shipping_sent,
      COALESCE(SUM(CASE WHEN status = 'delivered'       THEN 1 ELSE 0 END),0) as delivered,
      COALESCE(SUM(CASE WHEN status = 'whatsapp_failed' THEN 1 ELSE 0 END),0) as whatsapp_failed,
      COALESCE(SUM(CASE WHEN status = 'shipping_failed' THEN 1 ELSE 0 END),0) as shipping_failed
    FROM orders
    ${where}`,
    args,
  });
  return res.rows[0] || {};
}

// ─── WhatsApp Sessions ──────────────────────────────────────────────────────

async function upsertWhatsappSession(phone, orderId) {
  const client = getDb();
  const normalized = normalizePhoneForLookup(phone);
  return client.execute({
    sql: `INSERT OR REPLACE INTO whatsapp_sessions (phone, order_id, created_at)
          VALUES (?, ?, datetime('now'))`,
    args: [normalized, orderId],
  });
}

async function getSessionByPhone(phone) {
  const client = getDb();
  const normalized = normalizePhoneForLookup(phone);
  const res = await client.execute({ sql: 'SELECT * FROM whatsapp_sessions WHERE phone = ?', args: [normalized] });
  return res.rows[0] || null;
}

async function deleteSession(phone) {
  const client = getDb();
  const normalized = normalizePhoneForLookup(phone);
  return client.execute({ sql: 'DELETE FROM whatsapp_sessions WHERE phone = ?', args: [normalized] });
}

// ─── Settings ──────────────────────────────────────────────────────────────

async function getSetting(key) {
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return res.rows[0] ? res.rows[0].value : null;
}

async function getSettings(keys = []) {
  const client = getDb();
  if (keys.length === 0) {
    const res = await client.execute({ sql: 'SELECT key, value FROM settings', args: [] });
    return res.rows;
  }
  const placeholders = keys.map(() => '?').join(',');
  const res = await client.execute({ sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`, args: keys });
  return res.rows;
}

async function setSetting(key, value) {
  const client = getDb();
  return client.execute({
    sql: `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    args: [key, value],
  });
}

async function setSettings(obj) {
  const client = getDb();
  for (const [key, value] of Object.entries(obj)) {
    await client.execute({
      sql: `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      args: [key, String(value)],
    });
  }
}

// ─── Abandoned Checkouts ───────────────────────────────────────────────────

async function upsertAbandonedCheckout(checkout) {
  const client = getDb();
  return client.execute({
    sql: `INSERT INTO abandoned_checkouts (checkout_token, customer_name, customer_phone, total, checkout_url, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(checkout_token) DO UPDATE SET
            customer_name = excluded.customer_name,
            customer_phone = excluded.customer_phone,
            total = excluded.total,
            checkout_url = excluded.checkout_url,
            updated_at = datetime('now')`,
    args: [checkout.checkout_token, checkout.customer_name, checkout.customer_phone, checkout.total, checkout.checkout_url],
  });
}

async function getPendingAbandonedCheckouts() {
  const client = getDb();
  const res = await client.execute({
    sql: `SELECT * FROM abandoned_checkouts
          WHERE recovery_sent_at IS NULL
          AND created_at <= datetime('now', '-15 minutes')`,
    args: [],
  });
  return res.rows;
}

async function markCheckoutRecoverySent(token) {
  const client = getDb();
  return client.execute({
    sql: `UPDATE abandoned_checkouts SET recovery_sent_at = datetime('now') WHERE checkout_token = ?`,
    args: [token],
  });
}

// ─── Reviews ──────────────────────────────────────────────────────────────

async function markOrderReviewSent(orderId) {
  const client = getDb();
  return client.execute({
    sql: `UPDATE orders SET review_sent_at = datetime('now') WHERE shopify_order_id = ?`,
    args: [orderId],
  });
}

async function updateOrderRating(orderId, rating) {
  const client = getDb();
  return client.execute({
    sql: `UPDATE orders SET rating = ? WHERE shopify_order_id = ?`,
    args: [rating, orderId],
  });
}

async function getWhatsAppAuth(id) {
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT data FROM whatsapp_auth WHERE id = ?', args: [id] });
  return res.rows.length > 0 ? res.rows[0].data : null;
}

async function setWhatsAppAuth(id, data) {
  const client = getDb();
  await client.execute({
    sql: `INSERT INTO whatsapp_auth (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = datetime('now')`,
    args: [id, data, data]
  });
}

async function removeWhatsAppAuth(id) {
  const client = getDb();
  await client.execute({ sql: 'DELETE FROM whatsapp_auth WHERE id = ?', args: [id] });
}

// ─── WhatsApp Polls & LID Mapping (Baileys) ──────────────────────────────────

async function insertPollSecret(messageId, secretBase64, orderId = null, phone = null) {
  const client = getDb();
  return client.execute({
    sql: `INSERT OR REPLACE INTO whatsapp_polls (id, secret, order_id, phone, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    args: [messageId, secretBase64, orderId ? String(orderId) : null, phone ? normalizePhoneForLookup(phone) : null]
  });
}

async function getPollSecret(messageId) {
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT secret FROM whatsapp_polls WHERE id = ?', args: [messageId] });
  return res.rows[0] ? res.rows[0].secret : null;
}

async function getPollInfo(messageId) {
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT * FROM whatsapp_polls WHERE id = ?', args: [messageId] });
  return res.rows[0] || null;
}

async function saveLidMapping(lid, phone) {
  if (!lid || !phone) return;
  const cleanLid = String(lid).replace(/@lid|@c\.us|@s\.whatsapp\.net/g, '').trim();
  const cleanPhone = normalizePhoneForLookup(phone);
  if (!cleanLid || !cleanPhone || cleanLid === cleanPhone) return;
  const client = getDb();
  try {
    await client.execute({
      sql: `INSERT OR REPLACE INTO whatsapp_lid_mapping (lid, phone, created_at) VALUES (?, ?, datetime('now'))`,
      args: [cleanLid, cleanPhone]
    });
    console.log(`[DB/LID] 🔗 Mapped LID ${cleanLid} -> Phone ${cleanPhone}`);
  } catch (e) {}
}

async function getPhoneByLid(lid) {
  if (!lid) return null;
  const cleanLid = String(lid).replace(/@lid|@c\.us|@s\.whatsapp\.net/g, '').trim();
  const client = getDb();
  const res = await client.execute({ sql: 'SELECT phone FROM whatsapp_lid_mapping WHERE lid = ?', args: [cleanLid] });
  return res.rows[0]?.phone || null;
}

// ─── Quick Links ─────────────────────────────────────────────────────────────

async function getQuickLinks() {
  const client = await ready(); // make sure quick_links table exists first
  const res = await client.execute('SELECT * FROM quick_links ORDER BY sort_order ASC, id ASC');
  return res.rows;
}

async function addQuickLink(name, url) {
  const client = await ready();
  await client.execute({
    sql: 'INSERT INTO quick_links (name, url) VALUES (?, ?)',
    args: [name, url]
  });
}

async function deleteQuickLink(id) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM quick_links WHERE id = ?', args: [id] });
}

async function reorderQuickLinks(orderedIds) {
  const client = await ready();
  // Update sort_order for each id based on its position in the array
  for (let i = 0; i < orderedIds.length; i++) {
    await client.execute({
      sql: 'UPDATE quick_links SET sort_order = ? WHERE id = ?',
      args: [i, orderedIds[i]]
    });
  }
}

// ─── Workers ─────────────────────────────────────────────────────────────────

async function getWorkers() {
  const client = await ready();
  const res = await client.execute('SELECT * FROM workers ORDER BY id ASC');
  return res.rows;
}

async function addWorker(name, phone) {
  const client = await ready();
  await client.execute({ sql: 'INSERT INTO workers (name, phone) VALUES (?, ?)', args: [name, phone] });
}

async function deleteWorker(id) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM workers WHERE id = ?', args: [id] });
}

// ─── Tasks ───────────────────────────────────────────────────────────────────
// Stored server-side (not localStorage) so the background reminder job can
// see them and text the assigned worker(s) even with no browser open.

async function getTasks() {
  const client = await ready();
  const res = await client.execute('SELECT * FROM tasks ORDER BY done ASC, due_date ASC, id DESC');
  return res.rows;
}

async function addTask({ text, priority, dueDate, assigneeWorkerIds }) {
  const client = await ready();
  await client.execute({
    sql: 'INSERT INTO tasks (text, priority, due_date, assignee_worker_ids) VALUES (?, ?, ?, ?)',
    args: [text, priority || 'med', dueDate || null, JSON.stringify(assigneeWorkerIds || [])]
  });
}

async function toggleTask(id, done) {
  const client = await ready();
  await client.execute({ sql: 'UPDATE tasks SET done = ? WHERE id = ?', args: [done ? 1 : 0, id] });
}

async function deleteTask(id) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [id] });
}

async function clearDoneTasks() {
  const client = await ready();
  await client.execute('DELETE FROM tasks WHERE done = 1');
}

async function markTaskReminderSent(id) {
  const client = await ready();
  await client.execute({
    sql: "UPDATE tasks SET reminder_sent_at = datetime('now') WHERE id = ?",
    args: [id]
  });
}

// Tasks due within the next `hoursAhead` hours, not done, and that haven't
// already had a reminder sent — used by the background reminder job.
async function getTasksNeedingReminder(hoursAhead) {
  const client = await ready();
  const res = await client.execute({
    sql: `SELECT * FROM tasks
          WHERE done = 0
            AND reminder_sent_at IS NULL
            AND due_date IS NOT NULL
            AND datetime(due_date) <= datetime('now', '+' || ? || ' hours')
            AND datetime(due_date) >= datetime('now', '-1 hours')`,
    args: [hoursAhead]
  });
  return res.rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// USERS & SESSIONS (multi-user accounts, admin-approval signup)
// ═══════════════════════════════════════════════════════════════════════════

async function createUser(username, passwordHash, passwordSalt) {
  const client = await ready();
  await client.execute({
    sql: 'INSERT INTO users (username, password_hash, password_salt, status) VALUES (?, ?, ?, ?)',
    args: [username, passwordHash, passwordSalt, 'pending'],
  });
}

async function getUserByUsername(username) {
  const client = await ready();
  const res = await client.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
  return res.rows[0] || null;
}

async function getAllUsers() {
  const client = await ready();
  const res = await client.execute('SELECT id, username, status, created_at FROM users ORDER BY created_at DESC');
  return res.rows;
}

async function setUserStatus(id, status) {
  const client = await ready();
  await client.execute({ sql: 'UPDATE users SET status = ? WHERE id = ?', args: [status, id] });
  // Revoke any existing sessions immediately when suspending/rejecting —
  // otherwise a deactivated user stays logged in until the token expires.
  if (status !== 'active') {
    await client.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [id] });
  }
}

async function createSession(token, userId, username, role) {
  const client = await ready();
  await client.execute({
    sql: 'INSERT INTO sessions (token, user_id, username, role) VALUES (?, ?, ?, ?)',
    args: [token, userId, username, role],
  });
}

async function getSession(token) {
  const client = await ready();
  const res = await client.execute({ sql: 'SELECT * FROM sessions WHERE token = ?', args: [token] });
  return res.rows[0] || null;
}

async function deleteSessionByToken(token) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLIERS (server-side, shared across everyone)
// ═══════════════════════════════════════════════════════════════════════════

async function getSupplierGroups() {
  const client = await ready();
  const groups = (await client.execute('SELECT * FROM supplier_groups ORDER BY sort_order ASC, id ASC')).rows;
  const suppliers = (await client.execute('SELECT * FROM suppliers ORDER BY id ASC')).rows;
  return groups.map(g => ({ ...g, suppliers: suppliers.filter(s => s.group_id === g.id) }));
}

async function addSupplierGroup(name) {
  const client = await ready();
  await client.execute({ sql: 'INSERT INTO supplier_groups (name) VALUES (?)', args: [name] });
}

async function renameSupplierGroup(id, name) {
  const client = await ready();
  await client.execute({ sql: 'UPDATE supplier_groups SET name = ? WHERE id = ?', args: [name, id] });
}

async function deleteSupplierGroup(id) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM suppliers WHERE group_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM supplier_groups WHERE id = ?', args: [id] });
}

async function addSupplier({ groupId, name, product, phone, price, notes }) {
  const client = await ready();
  await client.execute({
    sql: 'INSERT INTO suppliers (group_id, name, product, phone, price, notes) VALUES (?, ?, ?, ?, ?, ?)',
    args: [groupId, name, product || '', phone || '', price || '', notes || ''],
  });
}

async function deleteSupplier(id) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM suppliers WHERE id = ?', args: [id] });
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTES (server-side, shared across everyone)
// ═══════════════════════════════════════════════════════════════════════════

async function getNoteFolders() {
  const client = await ready();
  const res = await client.execute('SELECT * FROM note_folders ORDER BY id ASC');
  return res.rows;
}

async function addNoteFolder(name, parentId) {
  const client = await ready();
  const res = await client.execute({
    sql: 'INSERT INTO note_folders (name, parent_id) VALUES (?, ?)',
    args: [name, parentId || null],
  });
  return Number(res.lastInsertRowid);
}

async function renameNoteFolder(id, name) {
  const client = await ready();
  await client.execute({ sql: 'UPDATE note_folders SET name = ? WHERE id = ?', args: [name, id] });
}

async function deleteNoteFolderRecursive(id) {
  const client = await ready();
  const children = (await client.execute({ sql: 'SELECT id FROM note_folders WHERE parent_id = ?', args: [id] })).rows;
  for (const c of children) await deleteNoteFolderRecursive(c.id);
  await client.execute({ sql: 'DELETE FROM notes WHERE folder_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM note_folders WHERE id = ?', args: [id] });
}

async function getNotes() {
  const client = await ready();
  const res = await client.execute('SELECT id, folder_id, title, updated_at FROM notes ORDER BY updated_at DESC');
  return res.rows;
}

async function getNoteById(id) {
  const client = await ready();
  const res = await client.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [id] });
  return res.rows[0] || null;
}

async function addNote(folderId) {
  const client = await ready();
  const res = await client.execute({
    sql: "INSERT INTO notes (folder_id, title, content) VALUES (?, '', '')",
    args: [folderId],
  });
  return Number(res.lastInsertRowid);
}

async function updateNote(id, title, content) {
  const client = await ready();
  await client.execute({
    sql: "UPDATE notes SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
    args: [title, content, id],
  });
}

async function moveNote(id, folderId) {
  const client = await ready();
  await client.execute({ sql: 'UPDATE notes SET folder_id = ? WHERE id = ?', args: [folderId, id] });
}

async function deleteNote(id) {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM notes WHERE id = ?', args: [id] });
}

// ─── Speedaf Area Codes ───────────────────────────────────────────────────────

async function upsertAreaCode({ code, name, nameAr, parentCode, level, fullPath }) {
  const client = await ready();
  await client.execute({
    sql: `INSERT INTO speedaf_area_codes (code, name, name_ar, parent_code, level, full_path, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(code) DO UPDATE SET
            name = excluded.name,
            name_ar = excluded.name_ar,
            parent_code = excluded.parent_code,
            level = excluded.level,
            full_path = excluded.full_path,
            synced_at = datetime('now')`,
    args: [code, name, nameAr || null, parentCode || null, level, fullPath || null],
  });
}

async function getAreasByParent(parentCode) {
  const client = await ready();
  const res = await client.execute({
    sql: 'SELECT * FROM speedaf_area_codes WHERE parent_code = ? ORDER BY name',
    args: [parentCode],
  });
  return res.rows;
}

async function getAreaByCode(code) {
  const client = await ready();
  const res = await client.execute({
    sql: 'SELECT * FROM speedaf_area_codes WHERE code = ?',
    args: [code],
  });
  return res.rows[0] || null;
}

async function searchAreas(query, level = null) {
  const client = await ready();
  let sql = 'SELECT * FROM speedaf_area_codes WHERE (name LIKE ? OR name_ar LIKE ?)';
  const args = [`%${query}%`, `%${query}%`];
  if (level) {
    sql += ' AND level = ?';
    args.push(level);
  }
  sql += ' ORDER BY level, name LIMIT 50';
  const res = await client.execute({ sql, args });
  return res.rows;
}

async function getAreaCount() {
  const client = await ready();
  const res = await client.execute({ sql: 'SELECT COUNT(*) as cnt FROM speedaf_area_codes', args: [] });
  return Number(res.rows[0]?.cnt || 0);
}

async function clearAreas() {
  const client = await ready();
  await client.execute({ sql: 'DELETE FROM speedaf_area_codes', args: [] });
}

async function getSpeedafProvinces() {
  const client = await ready();
  const res = await client.execute({
    sql: "SELECT code, name, name_ar FROM speedaf_area_codes WHERE level = 'province' ORDER BY name_ar ASC",
    args: [],
  });
  return res.rows;
}

async function getSpeedafAreasByProvince(provinceCode) {
  const client = await ready();
  const res = await client.execute({
    sql: "SELECT code, name, name_ar, parent_code FROM speedaf_area_codes WHERE parent_code = ? AND level = 'area' ORDER BY name_ar ASC",
    args: [provinceCode],
  });
  return res.rows;
}

// ─── Speedaf Order Tracking ───────────────────────────────────────────────────

async function updateSpeedafWaybill(orderId, waybillNo) {
  const client = await ready();
  await client.execute({
    sql: "UPDATE orders SET speedaf_waybill = ?, updated_at = datetime('now') WHERE id = ?",
    args: [waybillNo, orderId],
  });
}

async function updateSpeedafStatus(orderId, speedafStatus) {
  const client = await ready();
  await client.execute({
    sql: "UPDATE orders SET speedaf_status = ?, speedaf_status_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    args: [speedafStatus, orderId],
  });
}

async function getOrdersWithActiveSpeedaf() {
  const client = await ready();
  const res = await client.execute({
    sql: `SELECT * FROM orders
          WHERE speedaf_waybill IS NOT NULL
          AND deleted_at IS NULL
          AND status NOT IN ('delivered', 'cancelled')
          ORDER BY created_at DESC`,
    args: [],
  });
  return res.rows;
}

module.exports = {
  getDb,
  ready,
  insertOrder,
  updateOrderDetails,
  updateOrderStatus,
  updateOrderNotes,
  toggleOrderPrepared,
  getOrderByShopifyId,
  getOrderById,
  getOrderByPhone,
  getLatestActiveOrderByPhone,
  getAllOrders,
  deleteOrder,
  trashOrder,
  restoreOrder,
  permanentlyDeleteOrder,
  getTrashedOrders,
  deleteOrderByShopifyId,
  getOrderStats,
  upsertWhatsappSession,
  getSessionByPhone,
  deleteSession,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
  upsertAbandonedCheckout,
  getPendingAbandonedCheckouts,
  markCheckoutRecoverySent,
  markOrderReviewSent,
  updateOrderRating,
  normalizePhoneForLookup,
  getWhatsAppAuth,
  setWhatsAppAuth,
  removeWhatsAppAuth,
  insertPollSecret,
  getPollSecret,
  getPollInfo,
  saveLidMapping,
  getPhoneByLid,
  getQuickLinks,
  addQuickLink,
  deleteQuickLink,
  reorderQuickLinks,
  getWorkers,
  addWorker,
  deleteWorker,
  getTasks,
  addTask,
  toggleTask,
  deleteTask,
  clearDoneTasks,
  markTaskReminderSent,
  getTasksNeedingReminder,
  // Users & sessions
  createUser,
  getUserByUsername,
  getAllUsers,
  setUserStatus,
  createSession,
  getSession,
  deleteSessionByToken,
  // Suppliers
  getSupplierGroups,
  addSupplierGroup,
  renameSupplierGroup,
  deleteSupplierGroup,
  addSupplier,
  deleteSupplier,
  // Notes
  getNoteFolders,
  addNoteFolder,
  renameNoteFolder,
  deleteNoteFolderRecursive,
  getNotes,
  getNoteById,
  addNote,
  updateNote,
  moveNote,
  deleteNote,
  // Speedaf area codes
  upsertAreaCode,
  getAreasByParent,
  getAreaByCode,
  searchAreas,
  getAreaCount,
  clearAreas,
  getSpeedafProvinces,
  getSpeedafAreasByProvince,
  // Speedaf tracking
  updateSpeedafWaybill,
  updateSpeedafStatus,
  getOrdersWithActiveSpeedaf,
};

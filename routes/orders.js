'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { cancelShopifyOrder, deleteShopifyOrder, fetchShopifyOrders, parseShopifyOrder, updateShopifyOrderTags, syncManualTagsToShopify, getManualTagsFromShopify, updateShopifyOrderAddress, updateShopifyLineItemQuantity, requestSpeedafFulfillment } = require('../services/shopify');
const { sendOrderToStarlink } = require('../services/starlink');
const { syncStarlinkOrders } = require('../services/starlinkScraper');
const { sendOrderToSpeedaf, fetchSpeedafAreas, syncAllAreas, trackOrder, testSpeedafConnection, getSpeedafStats, matchGovernorateToSpeedafCode } = require('../services/speedaf');
const { fetchEasyOrders, parseEasyOrder } = require('../services/easyorders');
const { updateSourceStatus, cancelInSource } = require('../services/sourceAdapter');

// ─── Owner Alert ──────────────────────────────────────────────────────────────
// بيبعت رسالة واتساب لرقم صاحب المتجر في حالة أي خطأ
const OWNER_PHONE = process.env.OWNER_ALERT_PHONE || '201068093260';

async function notifyOwner(message) {
  try {
    const { sendWhatsAppMessageWithRetry } = require('../services/whatsapp');
    const timestamp = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
    const fullMsg = `🚨 *DopaConfirm Alert*\n${message}\n\n🕐 ${timestamp}`;
    await sendWhatsAppMessageWithRetry(OWNER_PHONE, fullMsg);
  } catch (e) {
    console.error('[Alert] Failed to notify owner:', e.message);
  }
}

// Export for use in other routes
module.exports.notifyOwner = notifyOwner;

// POST /api/orders/sync/starlink
router.post('/sync/starlink', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const result = await syncStarlinkOrders(username, password);
    if (!result.success) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/import-from-shopify
// Query params:
//   limit   - max orders per page (default 250, max 250 per Shopify API)
//   cleanup - if "true", trash any local orders not found in Shopify (orphan cleanup)
router.post('/import-from-shopify', async (req, res) => {
  try {
    const pageLimit = Math.min(parseInt(req.query.limit) || 250, 250);
    const doCleanup = req.query.cleanup === 'true';

    // ── Step 1: Fetch ALL orders from Shopify using cursor-based pagination ──
    const allShopifyOrders = [];
    let pageInfo = null;
    let fetchErrors = 0;

    do {
      const result = await fetchShopifyOrders(pageLimit, pageInfo);
      if (!result.success) {
        if (allShopifyOrders.length === 0) {
          return res.status(502).json({ error: 'Failed to fetch from Shopify', details: result.error });
        }
        // Partial failure mid-pagination — stop but process what we got
        console.warn('[Import] Pagination stopped early due to fetch error:', result.error);
        fetchErrors++;
        break;
      }
      allShopifyOrders.push(...result.orders);
      pageInfo = result.nextPageInfo || null; // undefined if no next page
    } while (pageInfo);

    // ── Step 2: Upsert all fetched orders into local DB ──────────────────────
    let imported = 0, updated = 0, skipped = 0;
    const shopifyIds = new Set();

    for (const order of allShopifyOrders) {
      const parsed = parseShopifyOrder(order);
      shopifyIds.add(String(parsed.shopify_order_id));

      const insertResult = await db.insertOrder(parsed);
      if (insertResult.rowsAffected > 0) {
        imported++;
      } else {
        const updateResult = await db.updateOrderDetails(parsed);
        if (updateResult.rowsAffected > 0) {
          updated++;
        } else {
          skipped++;
        }
      }
    }

    // ── Step 3 (optional): Cleanup orphaned local orders ─────────────────────
    // Orders that exist in our DB but are no longer in Shopify (missed webhook,
    // manual deletion, etc.) are soft-deleted into Trash so they stop appearing
    // in the dashboard and inflating the stats counters.
    let trashed = 0;
    if (doCleanup && shopifyIds.size > 0) {
      const client = db.getDb();
      // Only check non-simulated, non-deleted, non-cancelled orders to avoid
      // accidentally trashing things that were legitimately cancelled locally.
      const localRes = await client.execute({
        sql: `SELECT id, shopify_order_id FROM orders
              WHERE deleted_at IS NULL
              AND shopify_order_id NOT LIKE 'SIM-%'`,
        args: [],
      });

      for (const row of localRes.rows) {
        if (!shopifyIds.has(String(row.shopify_order_id))) {
          await db.trashOrder(row.id);
          trashed++;
          console.log(`[Import] Orphan order ${row.shopify_order_id} moved to trash (not found in Shopify)`);
        }
      }
    }

    if (global.broadcastSSE && (imported > 0 || updated > 0 || trashed > 0)) {
      global.broadcastSSE({ type: 'order_updated' });
    }

    res.json({
      success: true,
      fetched: allShopifyOrders.length,
      imported,
      updated,
      skipped,
      trashed,
      fetchErrors,
      cleanupRan: doCleanup,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/easyorders/test — فحص الاتصال بـ Easy Orders API
router.get('/easyorders/test', async (req, res) => {
  try {
    const { testEasyOrdersConnection } = require('../services/easyorders');
    const result = await testEasyOrdersConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/import-from-easyorders — استيراد الطلبات من Easy Orders
router.post('/import-from-easyorders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);

    const result = await fetchEasyOrders(page, limit);
    if (!result.success) {
      return res.status(502).json({ error: 'Failed to fetch from Easy Orders', details: result.error });
    }

    let imported = 0, updated = 0, skipped = 0;

    for (const rawOrder of result.orders) {
      const parsed = parseEasyOrder(rawOrder);
      if (!parsed.easyorders_id) continue;

      const insertResult = await db.insertOrder(parsed);
      if (insertResult.rowsAffected > 0) {
        imported++;
      } else {
        const updateResult = await db.updateOrderDetails(parsed);
        if (updateResult.rowsAffected > 0) {
          updated++;
        } else {
          skipped++;
        }
      }
    }

    if (global.broadcastSSE && (imported > 0 || updated > 0)) {
      global.broadcastSSE({ type: 'order_updated' });
    }

    res.json({
      success: true,
      fetched: result.orders.length,
      total: result.total,
      imported,
      updated,
      skipped,
      page,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/orders
router.get('/', async (req, res) => {
  try {
    let { status, search, date, sort, limit, review, source } = req.query;

    const sourceSetting = await db.getSetting('ORDER_SOURCE').catch(() => null) || process.env.ORDER_SOURCE || 'easyorders';

    // If source query parameter is not explicitly passed by client, default to configured ORDER_SOURCE setting
    if (!source) {
      source = sourceSetting;
    }

    let orders = await db.getAllOrders({ status, search, date, sort, limit, source });
    // Client-side review filter (review_sent_at is in DB, filter here)
    if (review === 'sent') {
      orders = orders.filter(o => !!o.review_sent_at);
    } else if (review === 'not_sent') {
      orders = orders.filter(o => !o.review_sent_at);
    }
    const stats = await db.getOrderStats({ source });
    res.json({ orders, stats, sourceSetting, activeSource: source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/export
router.get('/export', async (req, res) => {
  try {
    const { status, search, date, sort } = req.query;
    // Get orders with the same filters but without pagination limit
    const orders = await db.getAllOrders({ status, search, date, sort, limit: 10000 });
    
    // Add BOM for Excel UTF-8 support
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.write('\uFEFF'); 

    // CSV Header
    res.write('رقم الطلب,اسم العميل,رقم الهاتف,المنتجات,الإجمالي,الحالة,تاريخ الإنشاء,ملاحظات\n');

    for (const o of orders) {
      let itemsStr = '';
      try {
        const items = JSON.parse(o.items || '[]');
        itemsStr = items.map(i => `${i.name} (x${i.quantity})`).join(' | ');
      } catch (e) {}

      // Escape quotes for CSV
      const safe = str => str ? `"${String(str).replace(/"/g, '""')}"` : '""';

      const row = [
        safe(o.order_number),
        safe(o.customer_name),
        safe(o.customer_phone),
        safe(itemsStr),
        safe(o.total),
        safe(o.status),
        safe(o.created_at),
        safe(o.notes)
      ].join(',');
      
      res.write(row + '\n');
    }
    res.end();
  } catch (err) {
    res.status(500).send('Error exporting orders: ' + err.message);
  }
});

// GET /api/orders/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await db.getOrderStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/analytics
router.get('/analytics', async (req, res) => {
  try {
    const client = db.getDb();

    const [distRes, ratingsRes, cartsRes] = await Promise.all([
      client.execute({
        sql: `SELECT
          COALESCE(SUM(CASE WHEN status IN ('confirmed','shipping_sent','delivered') THEN 1 ELSE 0 END),0) as confirmed,
          COALESCE(SUM(CASE WHEN status IN ('pending_confirmation','whatsapp_sent','whatsapp_failed') THEN 1 ELSE 0 END),0) as pending,
          COALESCE(SUM(CASE WHEN status IN ('cancelled','shipping_failed') THEN 1 ELSE 0 END),0) as cancelled
          FROM orders`,
        args: [],
      }),
      client.execute({
        sql: `SELECT rating, COUNT(*) as cnt FROM orders WHERE rating IS NOT NULL GROUP BY rating`,
        args: [],
      }),
      client.execute({
        sql: `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN recovery_sent_at IS NOT NULL THEN 1 ELSE 0 END),0) as recovered
          FROM abandoned_checkouts`,
        args: [],
      }),
    ]);

    const dist   = distRes.rows[0]   || { confirmed: 0, pending: 0, cancelled: 0 };
    const carts  = cartsRes.rows[0]  || { total: 0, recovered: 0 };
    const ratings = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of ratingsRes.rows) {
      if (row.rating >= 1 && row.rating <= 5) ratings[row.rating] = Number(row.cnt);
    }

    res.json({
      statusDistribution: { confirmed: Number(dist.confirmed), pending: Number(dist.pending), cancelled: Number(dist.cancelled) },
      ratings,
      abandonedCarts: { total: Number(carts.total), recovered: Number(carts.recovered) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Quick Links API ─────────────────────────────────────────────────────────
// IMPORTANT: these must be registered BEFORE the generic '/:id' routes below,
// otherwise Express matches "/quick-links" as if "quick-links" were an :id
// (e.g. GET /api/orders/quick-links → matched by GET /:id with id="quick-links"
// → parseInt("quick-links") = NaN → DB throws "Only finite numbers... ").

router.get('/quick-links', async (req, res) => {
  try {
    const links = await db.getQuickLinks();
    res.json({ success: true, links });
  } catch (err) {
    console.error('[QuickLinks] GET error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/quick-links', async (req, res) => {
  try {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ success: false, error: 'name and url required' });
    if (!url.startsWith('http')) return res.status(400).json({ success: false, error: 'Invalid URL' });
    await db.addQuickLink(name.trim(), url.trim());
    const links = await db.getQuickLinks();
    res.json({ success: true, links });
  } catch (err) {
    console.error('[QuickLinks] POST error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/quick-links/:id', async (req, res) => {
  try {
    await db.deleteQuickLink(req.params.id);
    const links = await db.getQuickLinks();
    res.json({ success: true, links });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/quick-links/reorder — body: { orderedIds: [3,1,2,...] }
router.post('/quick-links/reorder', async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, error: 'orderedIds must be an array' });
    await db.reorderQuickLinks(orderedIds);
    const links = await db.getQuickLinks();
    res.json({ success: true, links });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Speedaf Area Codes & Tracking ──────────────────────────────────────────

// POST /api/orders/speedaf/sync-areas — مزامنة كل أكواد المناطق من Speedaf
router.post('/speedaf/sync-areas', async (req, res) => {
  try {
    const result = await syncAllAreas();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/speedaf/areas/:parentCode — جلب المناطق الفرعية
router.get('/speedaf/areas/:parentCode', async (req, res) => {
  try {
    const areas = await db.getAreasByParent(req.params.parentCode);
    if (areas.length === 0) {
      const liveResult = await fetchSpeedafAreas(req.params.parentCode);
      if (liveResult.success) {
        return res.json({ success: true, areas: liveResult.areas, source: 'live' });
      }
    }
    res.json({ success: true, areas, source: 'cache' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/speedaf/area-count — عدد المناطق المخزنة
router.get('/speedaf/area-count', async (req, res) => {
  try {
    const count = await db.getAreaCount();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/speedaf/test — اختبار اتصال Speedaf
router.get('/speedaf/test', async (req, res) => {
  try {
    const result = await testSpeedafConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/speedaf/stats — إحصائيات Speedaf
router.get('/speedaf/stats', async (req, res) => {
  try {
    const result = await getSpeedafStats();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/:id — single order
router.get('/:id', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/orders/:id
router.delete('/:id', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found in DB' });

    if (!String(order.shopify_order_id).startsWith('SIM-')) {
      await deleteShopifyOrder(order.shopify_order_id).catch(() => {});
    }

    if (order.customer_phone) await db.deleteSession(order.customer_phone);
    // Soft-delete: move to trash instead of permanently removing, so it
    // can be restored later if this was a mistake.
    await db.trashOrder(parseInt(req.params.id));
    res.json({ success: true, message: 'Order moved to trash' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/trash — list soft-deleted orders
router.get('/trash/list', async (req, res) => {
  try {
    const orders = await db.getTrashedOrders();
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/:id/restore — bring an order back from trash
router.post('/:id/restore', async (req, res) => {
  try {
    await db.restoreOrder(parseInt(req.params.id));
    if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/orders/:id/permanent — permanently remove from trash (irreversible)
router.delete('/:id/permanent', async (req, res) => {
  try {
    await db.permanentlyDeleteOrder(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/orders/:id/status
router.put('/:id/status', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });

    await db.updateOrderStatus(order.shopify_order_id, status);
    updateShopifyOrderTags(order.shopify_order_id, status).catch(e => {});
    if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated', order_id: order.shopify_order_id, status });

    if (status === 'cancelled' && !String(order.shopify_order_id).startsWith('SIM-')) {
      await cancelShopifyOrder(order.shopify_order_id, 'merchant');
    }
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/resend
router.post('/:id/resend', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.customer_phone) return res.status(400).json({ error: 'No phone number for this order' });

    const { sendWhatsAppMessageWithRetry, sendPollWithRetry, formatMessage, getMessageTemplate } = require('../services/whatsapp');
    const template = await getMessageTemplate();
    const messageText = formatMessage(template, order);
    const resultText = await sendWhatsAppMessageWithRetry(order.customer_phone, messageText, true);
    const pollMessage = 'برجاء اختيار رد من الخيارات بالأسفل لتأكيد طلبك وتجهيزه للشحن:';
    const pollOptions = [{ optionName: '✅ تأكيد الطلب' }, { optionName: '❌ تعديل أو إلغاء' }];
    const resultPoll = await sendPollWithRetry(order.customer_phone, pollMessage, pollOptions, order.shopify_order_id);

    if (resultText.success || resultPoll.success) {
      const now = new Date().toISOString();
      await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_sent', { whatsapp_sent_at: now });
      const { updateSourceStatus } = require('../services/sourceAdapter');
      updateSourceStatus(order, 'whatsapp_sent').catch(e => {});
      await db.upsertWhatsappSession(order.customer_phone, order.shopify_order_id);

      // Clear scheduled send time and mark as sent manually
      let notes = {};
      try { notes = JSON.parse(order.notes || '{}'); } catch {}
      delete notes.whatsapp_send_after;
      notes.sent_manually = true;
      await db.updateOrderNotes(order.id, JSON.stringify(notes));

      if (global.broadcastSSE) global.broadcastSSE({ type: 'status_update', orderId: order.shopify_order_id, status: 'whatsapp_sent' });
    } else {
      await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_failed', { whatsapp_sent_at: new Date().toISOString() });
      const { updateSourceStatus } = require('../services/sourceAdapter');
      updateSourceStatus(order, 'whatsapp_failed').catch(e => {});
    }
    res.json({ success: resultText.success || resultPoll.success, error: resultPoll.error || resultText.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/confirm
router.post('/:id/confirm', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const now = new Date().toISOString();
    await db.updateOrderStatus(order.shopify_order_id, 'confirmed', { customer_reply: 'manual_confirm', replied_at: now });
    updateSourceStatus(order, 'confirmed').catch(e => {});

    const shippingMode = await db.getSetting('SHIPPING_MODE');
    let shippingResult = { success: true };

    if (shippingMode === 'speedaf_auto' && !String(order.shopify_order_id).startsWith('SIM-')) {
      let govMatch = null;
      if (order.address) {
        const parts = order.address.split(/[-–,،]/).map(s => s.trim()).filter(Boolean);
        if (parts.length > 0) govMatch = await matchGovernorateToSpeedafCode(parts[0]);
      }

      if (govMatch) {
        shippingResult = await sendOrderToSpeedaf(order, { provinceCode: govMatch.code, provinceName: govMatch.name });
      } else {
        shippingResult = { success: false, error: 'يتطلب اختيار المدينة والحي' };
      }

      if (shippingResult.success) {
        await db.updateOrderStatus(order.shopify_order_id, 'shipping_sent', { shipping_sent_at: now });
        updateSourceStatus(order, 'shipping_sent').catch(e => {});
      }
    } else if (shippingMode === 'starlink_auto') {
      shippingResult = await sendOrderToStarlink(order.raw_payload);
      if (shippingResult.success) {
        await db.updateOrderStatus(order.shopify_order_id, 'shipping_sent', { shipping_sent_at: now });
        updateSourceStatus(order, 'shipping_sent').catch(e => {});
      } else {
        await db.updateOrderStatus(order.shopify_order_id, 'shipping_failed');
        updateSourceStatus(order, 'shipping_failed').catch(e => {});
      }
    }
    // manual mode: just leave as 'confirmed'

    if (order.customer_phone) await db.deleteSession(order.customer_phone);
    res.json({ success: shippingResult.success, shipping: shippingResult, shippingMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/send-to-speedaf — إرسال مباشر لـ Speedaf Direct API
router.post('/:id/send-to-speedaf', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.shopify_order_id).startsWith('SIM-') || String(order.order_number).startsWith('#SIM-')) {
      return res.json({ success: true, message: 'Simulated — skipped Speedaf call' });
    }

    // locationCodes contains { provinceCode, provinceName, districtCode, districtName }
    const { locationCodes, customAddress } = req.body;
    if (!locationCodes || !locationCodes.provinceCode) {
      return res.status(400).json({ success: false, error: 'اختار المحافظة والمنطقة أولاً' });
    }

    if (customAddress) {
      order.address = customAddress;
    }

    const { sendOrderToSpeedaf } = require('../services/speedaf');
    const result = await sendOrderToSpeedaf(order, locationCodes);
    if (result.success) {
      const now = new Date().toISOString();
      await db.updateOrderStatus(order.shopify_order_id, 'shipping_sent', { shipping_sent_at: now });
      const { updateSourceStatus } = require('../services/sourceAdapter');
      await updateSourceStatus(order, 'shipping_sent');
      if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated', order_id: order.shopify_order_id });
    }
    if (db.logActivity) db.logActivity(req.username, req.userRole, 'send_to_speedaf', `order #${order.order_number}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/speedaf/provinces — جلب كل المحافظات
router.get('/speedaf/provinces', async (req, res) => {
  try {
    let provinces = await db.getSpeedafProvinces();
    if (!provinces || provinces.length === 0) {
      const { syncAllAreas } = require('../services/speedaf');
      await syncAllAreas();
      provinces = await db.getSpeedafProvinces();
    }
    res.json({ success: true, provinces });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/speedaf/areas — جلب المناطق التابعة لمحافظة
router.get('/speedaf/areas', async (req, res) => {
  try {
    const { provinceCode } = req.query;
    if (!provinceCode) return res.status(400).json({ success: false, error: 'provinceCode مطلوب' });
    const areas = await db.getSpeedafAreasByProvince(provinceCode);
    res.json({ success: true, areas });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/speedaf/sync-areas — مزامنة أكواد المناطق والمحافظات
router.post('/speedaf/sync-areas', async (req, res) => {
  try {
    const { syncAllAreas } = require('../services/speedaf');
    const result = await syncAllAreas();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/speedaf/smart-match — مطابقة ذكية للمنطقة بالذكاء الاصطناعي
router.post('/speedaf/smart-match', async (req, res) => {
  try {
    const { address, provinceCode, provinceName } = req.body || {};
    if (!address || !provinceCode) {
      return res.status(400).json({ success: false, error: 'address و provinceCode مطلوبان' });
    }
    const { matchAreaWithGemini } = require('../services/speedaf');
    const result = await matchAreaWithGemini({ address, provinceCode, provinceName });
    if (result && result.matched) {
      return res.json({ success: true, area: result.matched, method: result.method });
    }
    res.json({ success: false, error: 'لم يتم العثور على مطابقة مؤكدة' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/:id/speedaf-track — تتبع شحنة واحدة
router.get('/:id/speedaf-track', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.speedaf_waybill) return res.status(400).json({ error: 'لا يوجد رقم بوليصة Speedaf لهذا الطلب' });
    
    const { trackOrder } = require('../services/speedaf');
    const result = await trackOrder(order.speedaf_waybill);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/speedaf/auto-login — تسجيل دخول تلقائي وحل الكابتشا عبر Gemini
router.post('/speedaf/auto-login', async (req, res) => {
  try {
    const { autoLoginSpeedaf } = require('../services/speedaf');
    const { geminiApiKey, account, password } = req.body || {};
    const result = await autoLoginSpeedaf(3, { geminiApiKey, account, password });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/speedaf/test — فحص الاتصال بـ Speedaf
router.get('/speedaf/test', async (req, res) => {
  try {
    const { testSpeedafConnection } = require('../services/speedaf');
    const result = await testSpeedafConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/:id/handed-to-courier — merchant manually confirms the
// physical package was handed over to the delivery rep. This does NOT
// fulfill the order in Shopify — fulfillment still only happens when
// Starlink sync later confirms actual delivery to the customer.
router.post('/:id/handed-to-courier', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await db.updateOrderStatus(order.shopify_order_id, 'handed_to_courier', { handed_to_courier_at: new Date().toISOString() });
    updateShopifyOrderTags(order.shopify_order_id, 'handed_to_courier').catch(e => {});
    if (db.logActivity) db.logActivity(req.username, req.userRole, 'handed_to_courier', `order #${order.order_number}`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/toggle-prepared — personal packing-checklist marker.
// Independent of the main status flow (confirmed/shipping_sent/etc.) —
// just a "did I pack this yet" flag so the merchant doesn't lose track.
// Also mirrors as a manual tag in Shopify so it's visible there too.
router.post('/:id/toggle-prepared', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const nowPrepared = !order.prepared_at;
    await db.toggleOrderPrepared(order.id, nowPrepared);

    // Sync as a manual tag (separate from the fixed STATUS_TAGS lifecycle)
    if (syncManualTagsToShopify && !String(order.shopify_order_id).startsWith('SIM-')) {
      let notes = {};
      try { notes = JSON.parse(order.notes || '{}'); } catch (e) {}
      let manualTags = notes.manual_tags || [];
      if (nowPrepared) {
        if (!manualTags.includes('تم تجهيز الأوردر')) manualTags.push('تم تجهيز الأوردر');
      } else {
        manualTags = manualTags.filter(t => t !== 'تم تجهيز الأوردر');
      }
      notes.manual_tags = manualTags;
      await db.updateOrderNotes(order.id, JSON.stringify(notes));
      syncManualTagsToShopify(order.shopify_order_id, manualTags).catch(e => {});
    }

    if (db.logActivity) db.logActivity(req.username, req.userRole, nowPrepared ? 'mark_prepared' : 'unmark_prepared', `order #${order.order_number}`);
    res.json({ success: true, prepared: nowPrepared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/orders/:id/edit — edit address/phone/name/note (always synced)
// and/or item quantities (synced via Shopify's Order Editing API — only
// works for orders whose items have a stored line_item_id).
router.put('/:id/edit', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { firstName, lastName, phone, address1, address2, city, province, country, note, quantityChanges } = req.body;
    const isSimulated = String(order.shopify_order_id).startsWith('SIM-');
    const warnings = [];

    // ─── Address / phone / name / note ───────────────────────────────────
    const hasAddressEdit = [firstName, lastName, phone, address1, address2, city, province, country, note].some(v => v !== undefined);
    if (hasAddressEdit && !isSimulated) {
      const addrResult = await updateShopifyOrderAddress(order.shopify_order_id, {
        firstName, lastName, phone, address1, address2, city, province, country, note,
      });
      if (!addrResult.success) warnings.push('العنوان: ' + addrResult.error);
    }

    // ─── Quantities ────────────────────────────────────────────────────────
    // quantityChanges: [{ line_item_id, quantity }]
    if (Array.isArray(quantityChanges) && quantityChanges.length > 0 && !isSimulated) {
      for (const change of quantityChanges) {
        if (!change.line_item_id) {
          warnings.push(`تعذر تعديل كمية منتج قديم (تم إنشاؤه قبل دعم تعديل الكمية) — عدّله يدوياً من Shopify`);
          continue;
        }
        const qtyResult = await updateShopifyLineItemQuantity(order.shopify_order_id, change.line_item_id, change.quantity);
        if (!qtyResult.success) warnings.push(`تعديل الكمية فشل: ${qtyResult.error}`);
      }
    }

    // Re-fetch the order from Shopify so our local copy matches exactly
    // what Shopify now has (new total, updated address string, etc.)
    if (!isSimulated) {
      const { fetchShopifyOrder } = require('../services/shopify');
      const freshResult = await fetchShopifyOrder(order.shopify_order_id);
      if (freshResult.success) {
        const parsed = parseShopifyOrder(freshResult.order);
        await db.updateOrderDetails(parsed);
      } else {
        warnings.push('تعذر تحديث نسخة الطلب المحلية من Shopify — البيانات المحلية القديمة لسه موجودة');
      }
    }

    if (db.logActivity) db.logActivity(req.username, req.userRole, 'edit_order', `order #${order.order_number}`);

    res.json({ success: true, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    const order = await db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const now = new Date().toISOString();
    await db.updateOrderStatus(order.shopify_order_id, 'cancelled', { customer_reply: 'manual_cancel', replied_at: now });
    updateSourceStatus(order, 'cancelled').catch(e => {});
    await cancelInSource(order, 'customer');
    if (order.customer_phone) await db.deleteSession(order.customer_phone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/review
router.post('/:id/review', async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'يمكن إرسال طلب التقييم فقط للطلبات المكتملة' });
    }

    // Use the SAME shared helper as the bulk review action: reads the
    // template + attached image from Settings, retries on failure.
    // Previously this route duplicated the logic inline with a different
    // template lookup, never sent the review image, and never marked
    // review_sent_at — so the ⭐/🔴 review badge stayed wrong forever
    // when sent from here instead of the bulk action.
    const { sendReviewRequest } = require('../services/whatsapp');
    const result = await sendReviewRequest(order);

    if (result.success) {
      await db.markOrderReviewSent(order.shopify_order_id);
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/:id/custom-message
router.post('/:id/custom-message', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'الرسالة لا يمكن أن تكون فارغة' });
    }

    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.customer_phone) return res.status(400).json({ error: 'لا يوجد رقم هاتف للعميل' });

    const { sendWhatsAppMessageWithRetry } = require('../services/whatsapp');
    const result = await sendWhatsAppMessageWithRetry(order.customer_phone, message);

    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/:id/notes
router.post('/:id/notes', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { notes } = req.body;
    await db.updateOrderNotes(orderId, notes || null);
    if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated', order_id: orderId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/bulk-action
router.post('/bulk-action', async (req, res) => {
  try {
    const { action, orderIds } = req.body; // orderIds is an array of local db 'id's
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'No orders selected' });
    }

    let successCount = 0;
    let failCount = 0;
    const failedIds = [];

    for (const id of orderIds) {
      try {
        const order = await db.getOrderById(id);
        if (!order) { failCount++; continue; }

        if (action === 'resend_whatsapp') {
          const { getMessageTemplate } = require('../services/whatsapp');
          const template = await getMessageTemplate();
          if (!template) throw new Error('No template');
          
          const { formatMessage, sendWhatsAppMessageWithRetry, sendPollWithRetry } = require('../services/whatsapp');
          const msgText = formatMessage(template, order);
          const rText = await sendWhatsAppMessageWithRetry(order.customer_phone, msgText);
          const pollOptions = [{ optionName: '✅ تأكيد الطلب' }, { optionName: '❌ تعديل أو إلغاء' }];
          const rPoll = await sendPollWithRetry(order.customer_phone, 'برجاء اختيار تأكيد الطلب:', pollOptions);
          
          if (rText.success || rPoll.success) {
            await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_sent', { whatsapp_sent_at: new Date().toISOString() });
            updateSourceStatus(order, 'whatsapp_sent').catch(e => {});
            await db.upsertWhatsappSession(order.customer_phone, order.shopify_order_id);
            successCount++;
          } else {
            failCount++;
          }
        } 
        else if (action === 'confirm_shipping') {
          const now = new Date().toISOString();
          await db.updateOrderStatus(order.shopify_order_id, 'confirmed', { customer_reply: 'bulk_manual_confirm', replied_at: now });
          updateSourceStatus(order, 'confirmed').catch(e => {});

          const shippingMode = await db.getSetting('SHIPPING_MODE');
          let result = { success: true };

          if (shippingMode === 'speedaf_auto' && !String(order.shopify_order_id).startsWith('SIM-')) {
            let govMatch = null;
            if (order.address) {
              const parts = order.address.split(/[-–,،]/).map(s => s.trim()).filter(Boolean);
              if (parts.length > 0) govMatch = await matchGovernorateToSpeedafCode(parts[0]);
            }
            if (govMatch) {
              result = await sendOrderToSpeedaf(order, { provinceCode: govMatch.code, provinceName: govMatch.name });
            }
          } else if (shippingMode === 'starlink_auto') {
            result = await sendOrderToStarlink(order.raw_payload);
          }
          // manual: just confirmed, no shipping call

          if (result.success) {
            if (shippingMode !== 'manual') {
              await db.updateOrderStatus(order.shopify_order_id, 'shipping_sent', { shipping_sent_at: new Date().toISOString() });
              updateSourceStatus(order, 'shipping_sent').catch(e => {});
            }
            successCount++;
          } else {
            await db.updateOrderStatus(order.shopify_order_id, 'shipping_failed');
            updateSourceStatus(order, 'shipping_failed').catch(e => {});
            failedIds.push(id);
            failCount++;
          }
          if (order.customer_phone) await db.deleteSession(order.customer_phone);
        }

        else if (action === 'request_review') {
          if (order.status !== 'delivered') { failCount++; failedIds.push(id); continue; }
          const { sendReviewRequest } = require('../services/whatsapp');
          const r = await sendReviewRequest(order);
          if (r.success) {
            await db.markOrderReviewSent(order.shopify_order_id);
            successCount++;
          } else {
            failCount++;
            failedIds.push(id);
          }
        }

        else if (action === 'delete') {
          if (order.source !== 'easyorders' && !String(order.shopify_order_id).startsWith('SIM-')) {
            await deleteShopifyOrder(order.shopify_order_id).catch(() => {});
          }
          if (order.customer_phone) await db.deleteSession(order.customer_phone);
          await db.trashOrder(id);
          successCount++;
        }

      } catch (e) {
        console.error(`[BulkAction] Error on order ${id}:`, e.message);
        failCount++;
        failedIds.push(id);
      }
    }

    // Alert owner on any failure
    if (failCount > 0) {
      notifyOwner(`⚠️ Bulk Action: ${action}\n❌ فشل: ${failCount} طلب\n✅ نجح: ${successCount} طلب\nالأوردرات الفاشلة: ${failedIds.join(', ')}`).catch(e => {});
    }

    if (global.broadcastSSE) global.broadcastSSE({ type: 'order_updated' });
    res.json({ success: true, successCount, failCount, failedIds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/:id/manual-tag
router.post('/:id/manual-tag', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, tag, index } = req.body;

    // جيب الأوردر وقرأ notes
    const client = db.getDb();
    const r = await client.execute({ sql: 'SELECT notes FROM orders WHERE id = ?', args: [id] });
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    let notes = {};
    try { notes = JSON.parse(r.rows[0].notes || '{}'); } catch {}
    if (!Array.isArray(notes.manual_tags)) notes.manual_tags = [];

    if (action === 'add') {
      if (!tag || !tag.trim()) return res.status(400).json({ success: false, error: 'Tag is empty' });
      if (!notes.manual_tags.includes(tag.trim())) {
        notes.manual_tags.push(tag.trim());
      }
      // لو التاج فيه كلمة "تقييم" — حدّث review_sent_at تلقائياً
      if (tag.includes('تقييم')) {
        const orderRow = await client.execute({ sql: 'SELECT shopify_order_id FROM orders WHERE id = ?', args: [id] });
        if (orderRow.rows.length > 0) {
          await db.markOrderReviewSent(orderRow.rows[0].shopify_order_id);
        }
      }
    } else if (action === 'remove') {
      if (typeof index === 'number' && index >= 0 && index < notes.manual_tags.length) {
        const removedTag = notes.manual_tags[index];
        notes.manual_tags.splice(index, 1);
        const stillHasReview = notes.manual_tags.some(t => t.includes('تقييم'));
        if (removedTag.includes('تقييم') && !stillHasReview) {
          const orderRow = await client.execute({ sql: 'SELECT shopify_order_id FROM orders WHERE id = ?', args: [id] });
          if (orderRow.rows.length > 0) {
            await client.execute({
              sql: 'UPDATE orders SET review_sent_at = NULL WHERE shopify_order_id = ?',
              args: [orderRow.rows[0].shopify_order_id]
            });
          }
        }
      }
    } else if (action === 'remove_review_only') {
      // بس امسح review_sent_at من غير ما تلمس التاجز
      const orderRow = await client.execute({ sql: 'SELECT shopify_order_id FROM orders WHERE id = ?', args: [id] });
      if (orderRow.rows.length > 0) {
        await client.execute({
          sql: 'UPDATE orders SET review_sent_at = NULL WHERE shopify_order_id = ?',
          args: [orderRow.rows[0].shopify_order_id]
        });
      }
    }

    await db.updateOrderNotes(id, JSON.stringify(notes));

    // Sync the full manual tags list to Shopify (fire-and-forget so the
    // dashboard doesn't wait on a Shopify round-trip for every tag click,
    // but still logged if it fails so it's not a silent data-loss risk).
    const orderRow = await client.execute({ sql: 'SELECT shopify_order_id FROM orders WHERE id = ?', args: [id] });
    if (orderRow.rows.length > 0) {
      syncManualTagsToShopify(orderRow.rows[0].shopify_order_id, notes.manual_tags)
        .then(r => { if (!r.success) console.error(`[ManualTags] Shopify sync failed for order ${id}:`, r.error); })
        .catch(e => console.error(`[ManualTags] Shopify sync error for order ${id}:`, e.message));
    }

    res.json({ success: true, tags: notes.manual_tags });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders/:id/resync-tags-from-shopify
// Recovery path: re-reads manual tags directly from Shopify's tags field
// and overwrites the local copy. Use this if the local DB was ever reset
// or the app was redeployed somewhere new — Shopify is the source of
// truth for manual tags, not the local database.
router.post('/:id/resync-tags-from-shopify', async (req, res) => {
  try {
    const { id } = req.params;
    const client = db.getDb();
    const r = await client.execute({ sql: 'SELECT notes, shopify_order_id FROM orders WHERE id = ?', args: [id] });
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const shopifyOrderId = r.rows[0].shopify_order_id;
    const result = await getManualTagsFromShopify(shopifyOrderId);
    if (!result.success) return res.status(500).json({ success: false, error: result.error });

    let notes = {};
    try { notes = JSON.parse(r.rows[0].notes || '{}'); } catch {}
    notes.manual_tags = result.manualTags;
    await db.updateOrderNotes(id, JSON.stringify(notes));

    res.json({ success: true, tags: notes.manual_tags });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

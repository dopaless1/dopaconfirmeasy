'use strict';

/**
 * Source Adapter — وسيط موحد لتحديث حالات الأوردرات
 * ─────────────────────────────────────────────────────
 * بدل ما كل route يشيك على ORDER_SOURCE بنفسه،
 * الأدابتر ده بيعمل الشغل ده مرة واحدة.
 */

const db = require('../database/db');

// Status mapping: internal status → Easy Orders status
const EASYORDERS_STATUS_MAP = {
  'pending_confirmation': 'pending',
  'whatsapp_sent': 'pending',
  'whatsapp_failed': 'pending',
  'confirmed': 'confirmed',
  'shipping_sent': 'waiting_for_pickup',
  'shipping_failed': 'confirmed',
  'handed_to_courier': 'in_delivery',
  'delivered': 'delivered',
  'cancelled': 'canceled',
  'needs_follow_up': 'pending',
};

/**
 * تحديث حالة الأوردر في المصدر الأصلي (Shopify أو Easy Orders)
 * @param {object} order - الأوردر من الـ DB
 * @param {string} status - الحالة الجديدة
 */
async function updateSourceStatus(order, status) {
  if (!order) return;

  const source = order.source || 'shopify';

  if (source === 'shopify' && order.shopify_order_id && !String(order.shopify_order_id).startsWith('SIM-')) {
    try {
      const { updateShopifyOrderTags } = require('./shopify');
      await updateShopifyOrderTags(order.shopify_order_id, status);
    } catch (e) {
      console.error('[SourceAdapter] Shopify tag update failed:', e.message);
    }
  } else if (source === 'easyorders' && (order.easyorders_id || order.shopify_order_id)) {
    try {
      const easyorders = require('./easyorders');
      const eoStatus = EASYORDERS_STATUS_MAP[status] || 'pending';
      await easyorders.updateOrderStatus(order.easyorders_id || order.shopify_order_id, eoStatus);
    } catch (e) {
      console.error('[SourceAdapter] Easy Orders status update failed:', e.message);
    }
  }
}

/**
 * إلغاء أوردر في المصدر الأصلي
 */
async function cancelInSource(order, reason = 'customer') {
  if (!order) return;
  const source = order.source || 'shopify';

  if (source === 'shopify' && order.shopify_order_id && !String(order.shopify_order_id).startsWith('SIM-')) {
    try {
      const { cancelShopifyOrder } = require('./shopify');
      await cancelShopifyOrder(order.shopify_order_id, reason);
    } catch (e) {
      console.error('[SourceAdapter] Shopify cancel failed:', e.message);
    }
  } else if (source === 'easyorders' && (order.easyorders_id || order.shopify_order_id)) {
    try {
      const easyorders = require('./easyorders');
      await easyorders.cancelEasyOrder(order.easyorders_id || order.shopify_order_id, reason);
    } catch (e) {
      console.error('[SourceAdapter] Easy Orders cancel failed:', e.message);
    }
  }
}

module.exports = { updateSourceStatus, cancelInSource, EASYORDERS_STATUS_MAP };

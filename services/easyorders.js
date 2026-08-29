'use strict';

/**
 * Easy Orders Service
 * ───────────────────
 * Handles API integration with Easy Orders platform:
 * - Order fetching & pagination
 * - Order status updates (confirmed, canceled, waiting_for_pickup, etc.)
 * - Parsing order webhook/payloads into internal schema
 */

const axios = require('axios');
const db = require('../database/db');

const DEFAULT_BASE_URL = 'https://api.easy-orders.net/api/v1';

async function getApiKey() {
  const key = await db.getSetting('EASYORDERS_API_KEY').catch(() => null);
  return key || process.env.EASYORDERS_API_KEY || '';
}

async function getBaseUrl() {
  const url = await db.getSetting('EASYORDERS_BASE_URL').catch(() => null);
  return (url || process.env.EASYORDERS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Common Axios client for Easy Orders API
 */
async function getClient() {
  const apiKey = await getApiKey();
  const baseURL = await getBaseUrl();

  return axios.create({
    baseURL,
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'api-key': apiKey,
      'x-api-key': apiKey,
      'Authorization': `Bearer ${apiKey}`,
    },
  });
}

/**
 * Parse an Easy Orders payload/webhook into the normalized internal order schema
 */
function parseEasyOrder(data) {
  const order = data.order || data;

  const id = String(order.id || order.order_id || order._id || '');
  const orderNumber = String(order.order_number || order.number || order.code || `#EO-${id}`);

  // Customer info
  const customerName = (
    order.customer_name ||
    order.customer?.name ||
    order.customer?.full_name ||
    order.name ||
    `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() ||
    'عميل'
  );

  const customerPhone = (
    order.customer_phone ||
    order.customer?.phone ||
    order.phone ||
    order.shipping_address?.phone ||
    null
  );

  // Products / Items
  const rawItems = order.items || order.products || order.line_items || order.order_items || [];
  const items = rawItems.map((item) => ({
    line_item_id: String(item.id || item.product_id || ''),
    product_id: String(item.product_id || item.id || ''),
    variant_id: String(item.variant_id || ''),
    name: item.name || item.title || item.product_name || 'منتج',
    quantity: Number(item.quantity || item.qty || 1),
    price: `${item.price || item.unit_price || 0} ${order.currency || 'EGP'}`.trim(),
    sku: item.sku || '',
  }));

  // Total
  const total = `${order.total || order.total_price || order.grand_total || 0} ${order.currency || 'EGP'}`.trim();

  // Address parsing — Easy Orders has governorate separate
  const governorate = (
    order.governorate ||
    order.province ||
    order.city ||
    order.shipping_address?.governorate ||
    order.shipping_address?.province ||
    order.shipping_address?.city ||
    ''
  );

  const detailedAddress = (
    order.detailed_address ||
    order.address ||
    order.shipping_address?.address ||
    order.shipping_address?.address1 ||
    ''
  );

  const addressParts = [governorate, detailedAddress].filter(Boolean);
  const address = addressParts.join(' - ') || 'غير محدد';

  return {
    source: 'easyorders',
    easyorders_id: id,
    shopify_order_id: id, // Keep backward compatible unique key in orders table
    order_number: orderNumber,
    customer_name: customerName,
    customer_phone: customerPhone,
    items: JSON.stringify(items),
    total,
    address,
    status: 'pending_confirmation',
    raw_payload: JSON.stringify(order),
  };
}

/**
 * Fetch orders from Easy Orders API
 * @param {number} page
 * @param {number} limit
 */
async function fetchEasyOrders(page = 1, limit = 50) {
  try {
    const client = await getClient();
    const response = await client.get('/orders', {
      params: { page, limit, per_page: limit },
    });

    const orders = response.data?.data || response.data?.orders || response.data || [];
    const total = response.data?.total || response.data?.meta?.total || orders.length;

    return {
      success: true,
      orders: Array.isArray(orders) ? orders : [],
      total,
      page,
    };
  } catch (err) {
    console.error('[EasyOrders] Fetch orders failed:', err.response?.data || err.message);
    return {
      success: false,
      orders: [],
      error: err.response?.data?.message || err.message,
    };
  }
}

/**
 * Fetch single order by ID
 */
async function fetchEasyOrder(orderId) {
  try {
    const client = await getClient();
    const response = await client.get(`/orders/${orderId}`);
    return { success: true, order: response.data?.data || response.data?.order || response.data };
  } catch (err) {
    console.error(`[EasyOrders] Fetch order ${orderId} failed:`, err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

/**
 * Update order status in Easy Orders
 * @param {string|number} orderId
 * @param {string} status - (e.g. pending, confirmed, waiting_for_pickup, in_delivery, delivered, canceled)
 */
async function updateOrderStatus(orderId, status) {
  if (!orderId) return { success: false, error: 'Order ID is required' };

  try {
    const client = await getClient();
    // Try standard status update endpoint
    const response = await client.put(`/orders/${orderId}/status`, { status });
    console.log(`[EasyOrders] Order ${orderId} status updated to ${status}`);
    return { success: true, data: response.data };
  } catch (err) {
    // Fallback: try PATCH /orders/:id
    try {
      const client = await getClient();
      const response = await client.patch(`/orders/${orderId}`, { status });
      console.log(`[EasyOrders] Order ${orderId} status patched to ${status}`);
      return { success: true, data: response.data };
    } catch (patchErr) {
      console.error(`[EasyOrders] Update status failed for order ${orderId}:`, patchErr.response?.data || patchErr.message);
      return { success: false, error: patchErr.response?.data?.message || patchErr.message };
    }
  }
}

/**
 * Cancel order in Easy Orders
 */
async function cancelEasyOrder(orderId, reason = 'customer') {
  if (!orderId) return { success: false, error: 'Order ID is required' };

  try {
    const client = await getClient();
    const response = await client.post(`/orders/${orderId}/cancel`, { reason });
    return { success: true, data: response.data };
  } catch (err) {
    // Fallback: update status to canceled
    return await updateOrderStatus(orderId, 'canceled');
  }
}

/**
 * Test connection to Easy Orders API
 */
async function testEasyOrdersConnection() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { success: false, error: 'EASYORDERS_API_KEY is not configured in settings' };
  }

  try {
    const client = await getClient();
    const response = await client.get('/orders', { params: { limit: 1 } });
    return { success: true, message: 'Connected to Easy Orders successfully', status: response.status };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message || `HTTP ${err.response?.status}`,
    };
  }
}

module.exports = {
  parseEasyOrder,
  fetchEasyOrders,
  fetchEasyOrder,
  updateOrderStatus,
  cancelEasyOrder,
  testEasyOrdersConnection,
};

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

const DEFAULT_BASE_URL = 'https://api.easy-orders.net/api/v1/external-apps';

async function getApiKey() {
  const key = await db.getSetting('EASYORDERS_API_KEY').catch(() => null);
  return key || process.env.EASYORDERS_API_KEY || '';
}

async function getBaseUrl() {
  const url = await db.getSetting('EASYORDERS_BASE_URL').catch(() => null);
  let base = (url || process.env.EASYORDERS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Auto-correct if user enters root api/v1 without external-apps
  if (base.endsWith('/api/v1')) {
    base += '/external-apps';
  } else if (!base.includes('external-apps') && base.includes('api.easy-orders.net')) {
    base = 'https://api.easy-orders.net/api/v1/external-apps';
  }
  return base;
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
      'Api-Key': apiKey,
      'api-key': apiKey,
      'Authorization': `Bearer ${apiKey}`,
    },
  });
}

/**
 * Parse an Easy Orders payload/webhook into the normalized internal order schema
 */
function parseEasyOrder(data) {
  if (!data) return { source: 'easyorders', easyorders_id: '' };

  const order = data.order || data.data?.order || data.data || data.payload || data;

  const id = String(
    order.id ||
    order.order_id ||
    order._id ||
    order.uuid ||
    order.code ||
    order.order_code ||
    order.number ||
    order.order_number ||
    `EO_${Date.now()}`
  );

  // Friendly human-readable order number
  let orderNumber = String(
    order.order_number ||
    order.number ||
    order.order_code ||
    order.code ||
    order.reference ||
    order.reference_id ||
    order.serial ||
    order.serial_number ||
    order.display_number ||
    order.display_id ||
    order.friendly_id ||
    order.human_id ||
    ''
  ).trim();

  if (!orderNumber || orderNumber === id) {
    if (id.includes('-') || id.length > 12) {
      orderNumber = `#EO-${id.substring(0, 8)}`;
    } else {
      orderNumber = `#EO-${id}`;
    }
  } else if (!orderNumber.startsWith('#')) {
    orderNumber = `#${orderNumber}`;
  }

  // Customer name
  let customerName = (
    order.customer_name ||
    order.client_name ||
    order.buyer_name ||
    order.recipient_name ||
    order.receiver_name ||
    order.customer?.name ||
    order.customer?.full_name ||
    order.client?.name ||
    order.client?.full_name ||
    order.buyer?.name ||
    order.shipping_address?.name ||
    order.shipping_address?.full_name ||
    order.shipping_address?.recipient_name ||
    order.shipping_address?.receiver_name ||
    order.billing_address?.name ||
    order.billing_address?.full_name ||
    order.user?.name ||
    order.user?.full_name ||
    `${order.customer?.first_name || order.client?.first_name || order.shipping_address?.first_name || order.first_name || ''} ${order.customer?.last_name || order.client?.last_name || order.shipping_address?.last_name || order.last_name || ''}`.trim() ||
    ''
  ).trim();

  if (!customerName && order.name && !String(order.name).startsWith('#') && !/^\d+$/.test(order.name)) {
    customerName = String(order.name).trim();
  }
  if (!customerName) customerName = 'عميل';

  // Customer phone
  let customerPhone = (
    order.customer_phone ||
    order.client_phone ||
    order.buyer_phone ||
    order.recipient_phone ||
    order.receiver_phone ||
    order.phone ||
    order.mobile ||
    order.telephone ||
    order.customer?.phone ||
    order.customer?.mobile ||
    order.client?.phone ||
    order.client?.mobile ||
    order.buyer?.phone ||
    order.buyer?.mobile ||
    order.shipping_address?.phone ||
    order.shipping_address?.mobile ||
    order.billing_address?.phone ||
    order.billing_address?.mobile ||
    order.user?.phone ||
    order.user?.mobile ||
    null
  );

  // Products / Items
  let rawItems = order.items || order.products || order.order_items || order.line_items || order.order_products || order.cart || order.details || order.product_list || order.variants || order.data?.items || order.data?.products || [];
  if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
    rawItems = Object.values(rawItems);
  }

  const currency = order.currency || 'EGP';

  const items = Array.isArray(rawItems) ? rawItems.map((item) => {
    const pName = (
      item.product_name ||
      item.name ||
      item.title ||
      item.product_title ||
      item.item_name ||
      item.product?.name ||
      item.product?.title ||
      item.product?.product_name ||
      item.variant?.name ||
      item.variant?.title ||
      'منتج'
    );
    const pQty = Number(item.quantity || item.qty || item.count || item.amount || item.ordered_quantity || 1) || 1;
    const pPriceNum = parseFloat(item.price || item.unit_price || item.product_price || item.total || item.product?.price || item.variant?.price || item.subtotal || 0) || 0;
    const pCurr = item.currency || currency;

    return {
      line_item_id: String(item.id || item.product_id || item._id || ''),
      product_id: String(item.product_id || item.id || ''),
      variant_id: String(item.variant_id || ''),
      name: pName,
      quantity: pQty,
      price: `${pPriceNum} ${pCurr}`.trim(),
      sku: item.sku || item.product?.sku || item.variant?.sku || '',
    };
  }) : [];

  // Total
  let totalNum = parseFloat(
    order.total ||
    order.total_price ||
    order.total_amount ||
    order.final_total ||
    order.grand_total ||
    order.order_total ||
    order.amount ||
    order.net_total ||
    order.price ||
    order.cost ||
    0
  );

  // If total is 0 but we have items, compute sum
  if ((!totalNum || totalNum === 0) && items.length > 0) {
    const itemsSum = items.reduce((sum, i) => {
      const priceVal = parseFloat(String(i.price).replace(/[^0-9.]/g, '')) || 0;
      return sum + (priceVal * (i.quantity || 1));
    }, 0);
    const shippingCost = parseFloat(order.shipping_cost || order.delivery_cost || order.shipping_fee || order.delivery_fee || order.shipping_price || 0) || 0;
    totalNum = itemsSum + shippingCost;
  }

  const total = `${totalNum || 0} ${currency}`.trim();

  // Address parsing
  const governorate = (
    order.governorate ||
    order.province ||
    order.state ||
    order.government ||
    order.zone ||
    order.shipping_address?.governorate ||
    order.shipping_address?.province ||
    order.shipping_address?.state ||
    order.shipping_address?.government ||
    ''
  );

  const city = (
    order.city ||
    order.area ||
    order.center ||
    order.district ||
    order.shipping_address?.city ||
    order.shipping_address?.area ||
    order.shipping_address?.center ||
    order.shipping_address?.district ||
    ''
  );

  const detailedAddress = (
    order.detailed_address ||
    order.address ||
    order.street ||
    order.address1 ||
    order.address2 ||
    order.shipping_address?.detailed_address ||
    order.shipping_address?.address ||
    order.shipping_address?.street ||
    order.shipping_address?.address1 ||
    order.shipping_address?.address2 ||
    ''
  );

  const addressParts = [governorate, city, detailedAddress].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
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
    // 1. Try direct GET /orders/:id
    try {
      const response = await client.get(`/orders/${orderId}`);
      const order = response.data?.data?.order || response.data?.data || response.data?.order || response.data;
      if (order && (order.id || order.customer || order.customer_name || order.items)) {
        return { success: true, order };
      }
    } catch (e) {}

    // 2. Try GET /orders with search parameter
    try {
      const response2 = await client.get('/orders', { params: { search: orderId, limit: 1 } });
      const orders = response2.data?.data || response2.data?.orders || response2.data;
      if (Array.isArray(orders) && orders.length > 0) {
        return { success: true, order: orders[0] };
      }
    } catch (e) {}

    return { success: false, error: 'Order not found in Easy Orders API' };
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
    return { success: false, error: 'EASYORDERS_API_KEY غير موجود في الإعدادات' };
  }

  try {
    const client = await getClient();
    // Try products endpoint first (standard check in Easy Orders external-apps API)
    try {
      const prodRes = await client.get('/products', { params: { limit: 1 } });
      return { success: true, message: 'متصل بـ Easy Orders بنجاح عبر Public API', status: prodRes.status };
    } catch (prodErr) {
      const orderRes = await client.get('/orders', { params: { limit: 1 } });
      return { success: true, message: 'متصل بـ Easy Orders بنجاح', status: orderRes.status };
    }
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message || `HTTP ${err.response?.status}`,
      status: err.response?.status,
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

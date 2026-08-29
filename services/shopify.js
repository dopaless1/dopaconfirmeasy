'use strict';

const axios = require('axios');

let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Get a temporary Access Token using Client Credentials Grant
 */
async function getAccessToken() {
  // 1. If permanent token is set in .env, just use it
  if (process.env.SHOPIFY_ACCESS_TOKEN) {
    return process.env.SHOPIFY_ACCESS_TOKEN;
  }

  // 2. Otherwise fallback to client credentials (old method)
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!store || !clientId || !clientSecret) {
    throw new Error('Shopify Client ID or Secret missing in .env');
  }

  const url = `https://${store}/admin/oauth/access_token`;

  try {
    const response = await axios.post(url, {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });

    cachedToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 86400;
    tokenExpiresAt = Date.now() + expiresIn * 1000 - 60000; // 1 min buffer

    console.log('[Shopify] Generated new dynamic access token (expires in 24h)');
    return cachedToken;
  } catch (err) {
    console.error('[Shopify] Failed to get access token:', err.response?.data || err.message);
    throw new Error('Failed to authenticate with Shopify: ' + (err.response?.data?.error || err.message));
  }
}

/**
 * Cancel a Shopify order
 * @param {string} orderId - Shopify order numeric ID
 * @param {string} reason - Cancellation reason
 */
async function cancelShopifyOrder(orderId, reason = 'customer') {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  const url = `https://${store}/admin/api/2024-01/orders/${orderId}/cancel.json`;

  try {
    const response = await axios.post(
      url,
      { reason },
      {
        timeout: 15000,
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Shopify] Order ${orderId} cancelled:`, response.data);
    return { success: true, data: response.data };
  } catch (err) {
    if (err.response) {
      console.error(`[Shopify] Cancel order ${orderId} failed HTTP ${err.response.status}:`, err.response.data);
      return {
        success: false,
        status: err.response.status,
        data: err.response.data,
        error: `HTTP ${err.response.status}`,
      };
    }
    console.error(`[Shopify] Cancel order ${orderId} network error:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Delete a Shopify order
 * @param {string} orderId - Shopify order numeric ID
 */
async function deleteShopifyOrder(orderId) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  const url = `https://${store}/admin/api/2024-01/orders/${orderId}.json`;

  try {
    const response = await axios.delete(url, {
      timeout: 15000,
      headers: {
        'X-Shopify-Access-Token': token,
      },
    });
    console.log(`[Shopify] Order ${orderId} deleted:`, response.data);
    return { success: true, data: response.data };
  } catch (err) {
    if (err.response) {
      console.error(`[Shopify] Delete order ${orderId} failed HTTP ${err.response.status}:`, err.response.data);
      return {
        success: false,
        status: err.response.status,
        data: err.response.data,
        error: `HTTP ${err.response.status}`,
      };
    }
    console.error(`[Shopify] Delete order ${orderId} network error:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Fetch a Shopify order by ID
 * @param {string} orderId - Shopify order numeric ID
 */
async function fetchShopifyOrder(orderId) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  const url = `https://${store}/admin/api/2024-01/orders/${orderId}.json`;

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'X-Shopify-Access-Token': token },
    });
    return { success: true, order: response.data.order };
  } catch (err) {
    if (err.response) {
      return {
        success: false,
        status: err.response.status,
        error: `HTTP ${err.response.status}`,
      };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Parse a Shopify order webhook payload into our internal format
 */
function parseShopifyOrder(order) {
  // Extract customer name
  const firstName = order.customer?.first_name || order.billing_address?.first_name || '';
  const lastName = order.customer?.last_name || order.billing_address?.last_name || '';
  const customerName = `${firstName} ${lastName}`.trim() || 'عميل';

  // Extract phone
  const customerPhone =
    order.customer?.phone ||
    order.billing_address?.phone ||
    order.shipping_address?.phone ||
    null;

  // Extract line items
  const items = (order.line_items || []).map((item) => ({
    line_item_id: item.id ? String(item.id) : null,
    product_id: item.product_id ? String(item.product_id) : null,
    variant_id: item.variant_id ? String(item.variant_id) : null,
    name: item.name || item.title,
    quantity: item.quantity,
    price: `${item.price} ${order.currency || ''}`.trim(),
    sku: item.sku || '',
  }));

  // Extract total
  const total = `${order.total_price} ${order.currency || ''}`.trim();

  // Extract shipping address
  const sa = order.shipping_address || order.billing_address || {};
  const addressParts = [sa.address1, sa.address2, sa.city, sa.province, sa.country]
    .filter(Boolean);
  const address = addressParts.join(', ') || 'غير محدد';

  return {
    shopify_order_id: String(order.id),
    order_number: order.name || `#${order.order_number}`,
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
 * Fetch recent orders from Shopify Admin API with cursor-based pagination.
 * @param {number} limit     - orders per page (max 250)
 * @param {string} pageInfo  - opaque cursor from a previous response's nextPageInfo
 */
async function fetchShopifyOrders(limit = 250, pageInfo = null) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  // Use page_info cursor when paginating, otherwise use date-desc ordering
  const qs = pageInfo
    ? `limit=${limit}&page_info=${encodeURIComponent(pageInfo)}`
    : `limit=${limit}&status=any&order=created_at+desc`;

  const url = `https://${store}/admin/api/2024-01/orders.json?${qs}`;

  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: { 'X-Shopify-Access-Token': token },
    });

    // Parse Link header for next-page cursor
    // Format: <...?page_info=XYZ&limit=N>; rel="next"
    let nextPageInfo = null;
    const linkHeader = response.headers['link'] || response.headers['Link'] || '';
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) nextPageInfo = decodeURIComponent(nextMatch[1]);
    }

    return { success: true, orders: response.data.orders || [], nextPageInfo };
  } catch (err) {
    if (err.response) {
      console.error(`[Shopify] Fetch orders failed HTTP ${err.response.status}:`, err.response.data);
      return { success: false, status: err.response.status, error: `HTTP ${err.response.status} - ${JSON.stringify(err.response.data)}` };
    }
    return { success: false, error: err.message };
  }
}


/**
 * Mark a Shopify order as Paid
 * @param {string} orderId
 */
async function markOrderAsPaid(orderId) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  try {
    // 1. Fetch order to get total price and check financial status
    const orderRes = await fetchShopifyOrder(orderId);
    if (!orderRes.success) return orderRes;
    
    if (orderRes.order.financial_status === 'paid') {
      return { success: true, message: 'Already paid' };
    }

    const amount = orderRes.order.total_price;
    const url = `https://${store}/admin/api/2024-01/orders/${orderId}/transactions.json`;

    const response = await axios.post(
      url,
      {
        transaction: {
          kind: 'capture',
          status: 'success',
          amount: amount,
          gateway: 'manual'
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Shopify] Order ${orderId} marked as paid.`);
    return { success: true, transaction: response.data.transaction };
  } catch (err) {
    console.error(`[Shopify] Failed to mark ${orderId} as paid:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Mark a Shopify order as Fulfilled
 * @param {string} orderId
 */
async function fulfillShopifyOrder(orderId) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  try {
    // 1. Get Fulfillment Orders for this order
    const foUrl = `https://${store}/admin/api/2024-01/orders/${orderId}/fulfillment_orders.json`;
    const foRes = await axios.get(foUrl, {
      headers: { 'X-Shopify-Access-Token': token },
    });

    console.log('Fulfillment Orders JSON:', JSON.stringify(foRes.data, null, 2));

    const fulfillmentOrders = foRes.data.fulfillment_orders || [];
    
    // Find an open fulfillment order
    const openFO = fulfillmentOrders.find(fo => fo.status === 'open' || fo.status === 'in_progress');
    
    if (!openFO) {
      return { success: true, message: 'No open fulfillment orders found (already fulfilled?)' };
    }

    // 2. Create Fulfillment
    const fulfillUrl = `https://${store}/admin/api/2024-01/fulfillments.json`;
    const fulfillRes = await axios.post(
      fulfillUrl,
      {
        fulfillment: {
          message: 'تم الشحن والتسليم عبر Starlink',
          notify_customer: false,
          line_items_by_fulfillment_order: [
            { fulfillment_order_id: openFO.id }
          ]
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );
    
    console.log(`[Shopify] Order ${orderId} fulfilled.`);
    return { success: true, fulfillment: fulfillRes.data.fulfillment };
  } catch (err) {
    console.error(`[Shopify] Failed to fulfill ${orderId}:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

const STATUS_TAGS = {
  'pending_confirmation': 'في انتظار التأكيد واتساب',
  'whatsapp_sent': 'تم إرسال واتساب',
  'whatsapp_failed': 'فشل إرسال واتساب',
  'confirmed': 'تم التأكيد واتساب',
  'shipping_sent': 'تم تبليغ شركه الشحن',
  'shipping_failed': 'فشل الارسال للشحن',
  'handed_to_courier': 'تم التسليم لمندوب الشحن',
  'delivered': 'تم التسليم',
  'cancelled': 'ملغي',
  'review_sent': 'تم ارسال تقييم للعميل'
};

async function updateShopifyOrderTags(orderId, status) {
  if (!orderId || String(orderId).startsWith('SIM-') || isNaN(Number(orderId))) {
    return { success: true, message: 'Skipped for simulated order' };
  }

  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();

  if (!store || !token) {
    return { success: false, error: 'Shopify credentials not configured' };
  }

  try {
    const orderRes = await fetchShopifyOrder(orderId);
    if (!orderRes.success) return orderRes;

    const currentTagsStr = orderRes.order.tags || '';
    let tagList = currentTagsStr.split(',').map(t => t.trim()).filter(Boolean);

    const statusTagValues = Object.values(STATUS_TAGS);
    tagList = tagList.filter(t => !statusTagValues.includes(t));

    const newTag = STATUS_TAGS[status];
    if (newTag) {
      tagList.push(newTag);
    }

    const updatedTagsStr = tagList.join(', ');
    console.log(`[Shopify] Updating tags for order ${orderId}: "${updatedTagsStr}"`);

    const updateUrl = `https://${store}/admin/api/2024-01/orders/${orderId}.json`;
    await axios.put(
      updateUrl,
      { order: { id: Number(orderId), tags: updatedTagsStr } },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    return { success: true, tags: updatedTagsStr };
  } catch (err) {
    console.error(`[Shopify] Failed to update tags for order ${orderId}:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// ─── Manual Tags Sync ────────────────────────────────────────────────────────
// Manual tags (e.g. "VIP", "بلاك ليست", "تم التقييم") are prefixed with
// "MT:" when stored in Shopify's tags field. This lets us tell them apart
// from the fixed STATUS_TAGS values on the same order, both when writing
// (so we don't wipe them when the status changes) and when reading them
// back (see getManualTagsFromShopify below) — this is the source-of-truth
// recovery path: if the local DB is ever lost/reset, manual tags are not
// gone, they can always be re-read straight from Shopify.
const MANUAL_TAG_PREFIX = 'MT:';

function encodeManualTag(tag) { return `${MANUAL_TAG_PREFIX}${tag}`; }
function decodeManualTag(shopifyTag) { return shopifyTag.startsWith(MANUAL_TAG_PREFIX) ? shopifyTag.slice(MANUAL_TAG_PREFIX.length) : null; }

async function syncManualTagsToShopify(orderId, manualTags) {
  if (!orderId || String(orderId).startsWith('SIM-') || isNaN(Number(orderId))) {
    return { success: true, message: 'Skipped for simulated order' };
  }

  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();
  if (!store || !token) return { success: false, error: 'Shopify credentials not configured' };

  try {
    const orderRes = await fetchShopifyOrder(orderId);
    if (!orderRes.success) return orderRes;

    const currentTagsStr = orderRes.order.tags || '';
    let tagList = currentTagsStr.split(',').map(t => t.trim()).filter(Boolean);

    // Keep everything that ISN'T one of our own manual tags (status tags +
    // any tags the merchant added manually in Shopify itself stay untouched)
    tagList = tagList.filter(t => decodeManualTag(t) === null);

    // Re-add the current full set of manual tags from the local DB
    (manualTags || []).forEach(t => tagList.push(encodeManualTag(t)));

    const updatedTagsStr = tagList.join(', ');
    const updateUrl = `https://${store}/admin/api/2024-01/orders/${orderId}.json`;
    await axios.put(
      updateUrl,
      { order: { id: Number(orderId), tags: updatedTagsStr } },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    return { success: true, tags: updatedTagsStr };
  } catch (err) {
    console.error(`[Shopify] Failed to sync manual tags for order ${orderId}:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// Recovery path: read manual tags straight from Shopify's tags field.
// Used by the "resync from Shopify" action so nothing is lost even if
// the local database was wiped or the code was redeployed elsewhere.
async function getManualTagsFromShopify(orderId) {
  const orderRes = await fetchShopifyOrder(orderId);
  if (!orderRes.success) return { success: false, error: orderRes.error };
  const tagList = (orderRes.order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const manualTags = tagList.map(decodeManualTag).filter(Boolean);
  return { success: true, manualTags };
}

// ─── Order Editing ───────────────────────────────────────────────────────────

/**
 * Updates the shipping address / customer name / phone / note on an
 * existing order. This is a simple REST PUT — Shopify allows changing
 * these fields on an order directly.
 */
async function updateShopifyOrderAddress(orderId, { firstName, lastName, phone, address1, address2, city, province, country, note }) {
  if (!orderId || String(orderId).startsWith('SIM-') || isNaN(Number(orderId))) {
    return { success: true, message: 'Skipped for simulated order' };
  }
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();
  if (!store || !token) return { success: false, error: 'Shopify credentials not configured' };

  try {
    const shippingAddress = {};
    if (firstName !== undefined) shippingAddress.first_name = firstName;
    if (lastName !== undefined) shippingAddress.last_name = lastName;
    if (phone !== undefined) shippingAddress.phone = phone;
    if (address1 !== undefined) shippingAddress.address1 = address1;
    if (address2 !== undefined) shippingAddress.address2 = address2;
    if (city !== undefined) shippingAddress.city = city;
    if (province !== undefined) shippingAddress.province = province;
    if (country !== undefined) shippingAddress.country = country;

    const body = { order: { id: Number(orderId) } };
    if (Object.keys(shippingAddress).length > 0) body.order.shipping_address = shippingAddress;
    if (note !== undefined) body.order.note = note;

    const url = `https://${store}/admin/api/2024-01/orders/${orderId}.json`;
    const res = await axios.put(url, body, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return { success: true, order: res.data.order };
  } catch (err) {
    console.error(`[Shopify] Failed to update address for order ${orderId}:`, err.response?.data || err.message);
    return { success: false, error: err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message };
  }
}

/**
 * Changes the quantity of an EXISTING line item on an order that's
 * already been placed. Regular order fields can be edited via a simple
 * REST PUT, but line items require Shopify's GraphQL "Order Editing" API
 * (orderEditBegin → orderEditSetQuantity → orderEditCommit) — there is no
 * simpler REST equivalent for this.
 *
 * NOTE: this only works for orders that were parsed AFTER line_item_id
 * started being stored (see parseShopifyOrder). Older orders won't have
 * a line_item_id to target.
 */
async function updateShopifyLineItemQuantity(orderId, lineItemId, newQuantity) {
  if (!orderId || String(orderId).startsWith('SIM-') || isNaN(Number(orderId))) {
    return { success: true, message: 'Skipped for simulated order' };
  }
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();
  if (!store || !token) return { success: false, error: 'Shopify credentials not configured' };

  const graphqlUrl = `https://${store}/admin/api/2024-01/graphql.json`;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  async function gql(query, variables) {
    const res = await axios.post(graphqlUrl, { query, variables }, { headers, timeout: 20000 });
    if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
    return res.data.data;
  }

  try {
    const orderGid = `gid://shopify/Order/${orderId}`;

    // 1. Begin the edit session
    const beginRes = await gql(
      `mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: orderGid }
    );
    if (beginRes.orderEditBegin.userErrors.length > 0) {
      return { success: false, error: beginRes.orderEditBegin.userErrors.map(e => e.message).join(', ') };
    }
    const calculatedOrderId = beginRes.orderEditBegin.calculatedOrder.id;

    // 2. Find the calculated line item matching our original line item,
    // since orderEditSetQuantity needs the CALCULATED line item's ID, not
    // the original order's line item ID.
    const lineItemGid = `gid://shopify/LineItem/${lineItemId}`;
    const calcRes = await gql(
      `query getCalculatedOrder($id: ID!) {
        calculatedOrder: node(id: $id) {
          ... on CalculatedOrder {
            lineItems(first: 50) {
              edges {
                node {
                  id
                  quantity
                  originalLineItem { id }
                }
              }
            }
          }
        }
      }`,
      { id: calculatedOrderId }
    );
    const match = calcRes.calculatedOrder.lineItems.edges.find(
      e => e.node.originalLineItem && e.node.originalLineItem.id === lineItemGid
    );
    if (!match) {
      return { success: false, error: 'تعذر إيجاد المنتج داخل نظام تعديل الطلب في Shopify' };
    }

    // 3. Set the new quantity
    const setQtyRes = await gql(
      `mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
        orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, lineItemId: match.node.id, quantity: newQuantity }
    );
    if (setQtyRes.orderEditSetQuantity.userErrors.length > 0) {
      return { success: false, error: setQtyRes.orderEditSetQuantity.userErrors.map(e => e.message).join(', ') };
    }

    // 4. Commit the edit — notifyCustomer:false since we handle customer
    // communication ourselves via WhatsApp.
    const commitRes = await gql(
      `mutation orderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
        orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
          order { id }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, notifyCustomer: false, staffNote: 'تم تعديل الكمية من لوحة DopaConfirm' }
    );
    if (commitRes.orderEditCommit.userErrors.length > 0) {
      return { success: false, error: commitRes.orderEditCommit.userErrors.map(e => e.message).join(', ') };
    }

    return { success: true };
  } catch (err) {
    console.error(`[Shopify] Failed to update quantity for order ${orderId}:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get fulfillment orders for a Shopify order.
 * Returns the list of fulfillment order objects (each has an id, status,
 * assigned_location, line items, etc.)
 */
async function getFulfillmentOrders(shopifyOrderId) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();
  if (!store || !token) return { success: false, error: 'Shopify credentials not configured' };

  try {
    const url = `https://${store}/admin/api/2024-01/orders/${shopifyOrderId}/fulfillment_orders.json`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'X-Shopify-Access-Token': token },
    });
    return { success: true, fulfillmentOrders: res.data.fulfillment_orders || [] };
  } catch (err) {
    return { success: false, error: err.response?.data || err.message };
  }
}

/**
 * Request fulfillment of a Shopify order via the Speedaf App
 * (registered as a Fulfillment Service in Shopify).
 *
 * This is the programmatic equivalent of:
 *   Shopify Orders → select order → ... → Apps → Speedaf
 *
 * Shopify routes the request to the Speedaf app automatically.
 */
async function requestSpeedafFulfillment(shopifyOrderId) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getAccessToken();
  if (!store || !token) return { success: false, error: 'Shopify credentials not configured' };

  try {
    // Step 1: get the fulfillment order(s) for this order
    const foResult = await getFulfillmentOrders(shopifyOrderId);
    if (!foResult.success) return foResult;

    // We only care about fulfillment orders that are not yet fulfilled / sent
    const open = foResult.fulfillmentOrders.filter(fo =>
      ['open', 'in_progress', 'scheduled'].includes(fo.status)
    );

    if (open.length === 0) {
      console.warn(`[Speedaf] No open fulfillment orders for Shopify order ${shopifyOrderId}`);
      return { success: false, error: 'No open fulfillment orders found — order may already be fulfilled' };
    }

    const results = [];
    for (const fo of open) {
      const url = `https://${store}/admin/api/2024-01/fulfillment_orders/${fo.id}/fulfillment_requests.json`;
      const payload = {
        fulfillment_request: {
          message: 'Order confirmed via DopaConfirm',
        },
      };

      console.log(`[Speedaf] Requesting fulfillment for FO#${fo.id} (order ${shopifyOrderId})`);
      const res = await axios.post(url, payload, {
        timeout: 20000,
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      });

      const ok = res.status >= 200 && res.status < 300;
      console.log(`[Speedaf] FO#${fo.id} → HTTP ${res.status}`);

      if (res.status === 406) {
        console.warn(`[Speedaf] ⚠️ HTTP 406: Speedaf app is NOT registered as a native Fulfillment Service.`);
        console.warn(`[Speedaf] If Speedaf relies on the 'More Actions' dropdown, it cannot be triggered via this Shopify API.`);
        // To fix this, we must either:
        // 1) Use the Speedaf REST API directly (via services/speedaf.js)
        // 2) Or create a standard fulfillment and hope Speedaf catches the webhook.
      }

      results.push({ fulfillmentOrderId: fo.id, success: ok, status: res.status, data: res.data });
    }

    const anySuccess = results.some(r => r.success);
    return { success: anySuccess, results };


  } catch (err) {
    console.error('[Speedaf] requestSpeedafFulfillment error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { 
  cancelShopifyOrder, 
  deleteShopifyOrder,
  fetchShopifyOrder, 
  fetchShopifyOrders, 
  parseShopifyOrder, 
  getAccessToken,
  markOrderAsPaid,
  fulfillShopifyOrder,
  updateShopifyOrderTags,
  syncManualTagsToShopify,
  getManualTagsFromShopify,
  updateShopifyOrderAddress,
  updateShopifyLineItemQuantity,
  getFulfillmentOrders,
  requestSpeedafFulfillment,
  STATUS_TAGS,
};

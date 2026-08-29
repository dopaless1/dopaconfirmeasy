'use strict';

const axios = require('axios');

/**
 * Forward a Shopify order payload to Starlink Delivery API.
 * Preserves the Shopify structure while removing only heavy fields.
 */
async function sendOrderToStarlink(rawPayload) {
  const apiUrl = process.env.STARLINK_API_URL;
  if (!apiUrl) {
    return { success: false, error: 'STARLINK_API_URL not configured' };
  }

  // Parse the payload if it's a string
  let payloadObj;
  try {
    payloadObj = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  } catch (err) {
    return { success: false, error: 'Invalid payload JSON: ' + err.message };
  }

  console.log(`[Starlink] → Preparing order ${payloadObj.name || payloadObj.id} for Starlink`);
  
 
  // If it's a simulated order, fake a success to avoid 500 errors from Starlink
  if (payloadObj.name && payloadObj.name.startsWith('#SIM-')) {
    console.log(`[Starlink] ⚠️ Simulated order detected, faking success response`);
    return { success: true, message: 'Simulated success', raw: 'mock' };
  }

  // Clone Shopify payload so we don't modify the original object
const payload = JSON.parse(JSON.stringify(payloadObj));

// Remove only heavy fields while keeping Shopify structure intact
[
  'client_details',
'discount_applications',
'fulfillments',
'refunds',
'payment_terms',
'returns',
'line_item_groups',
'landing_site',
'landing_site_ref',
'device_id',
'original_total_additional_fees_set',
'original_total_duties_set',
'total_cash_rounding_payment_adjustment_set',
'total_cash_rounding_refund_adjustment_set'
].forEach(key => delete payload[key]);

// Remove heavy nested fields
(payload.line_items || []).forEach(item => {
  delete item.properties;
delete item.discount_allocations;
});

(payload.shipping_lines || []).forEach(line => {
  delete line.discount_allocations;
});

const finalPayloadStr = JSON.stringify(payload);

console.log(
  `[Starlink] 📦 Forwarding Shopify-compatible payload: ${finalPayloadStr.length} bytes | Order: ${payloadObj.name || payloadObj.id}`
);

console.log(`[Starlink] Payload size: ${Buffer.byteLength(finalPayloadStr)} bytes`);
console.log(`[Starlink] Payload: ${finalPayloadStr.substring(0, 1500)}`);

  // ─── Retry logic: 3 attempts ─────────────────────────────────────────────
  const MAX_ATTEMPTS = 3;
  const DELAY_MS = [0, 5000, 10000];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (DELAY_MS[attempt - 1] > 0) {
      console.log(`[Starlink] ⏳ Waiting ${DELAY_MS[attempt - 1] / 1000}s before attempt ${attempt}...`);
      await new Promise(r => setTimeout(r, DELAY_MS[attempt - 1]));
    }

    console.log(`[Starlink] 🔄 Attempt ${attempt}/${MAX_ATTEMPTS} → POST ${apiUrl}`);

    try {
      const response = await axios({
        method: 'POST',
        url: apiUrl,
        data: finalPayloadStr,
        timeout: 30000,
        responseType: 'text',
        headers: {
  'Content-Type': 'application/json',
  'Content-Length': Buffer.byteLength(finalPayloadStr),
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Shopify-Webhook/1.0',
},
        validateStatus: () => true,
      });

      const success = response.status >= 200 && response.status < 300;
      console.log(`[Starlink] ← HTTP ${response.status} | Success: ${success} | Attempt: ${attempt}`);
      console.log('[Starlink] Response:', String(response.data || '(empty)').substring(0, 500));
	  console.log('[Starlink] Response headers:', response.headers);

      if (success) {
        return { success: true, status: response.status, data: response.data };
      }

      // 4xx — client error, don't retry
      if (response.status >= 400 && response.status < 500) {
        return { success: false, status: response.status, data: response.data, error: `HTTP ${response.status}: ${String(response.data).substring(0, 200)}` };
      }

      // 5xx — server error, retry
      if (attempt === MAX_ATTEMPTS) {
        return { success: false, status: response.status, data: response.data, error: `HTTP ${response.status} after ${MAX_ATTEMPTS} attempts` };
      }

    } catch (err) {
      console.error(`[Starlink] Network error attempt ${attempt}:`, err.message);
      if (attempt === MAX_ATTEMPTS) {
        return { success: false, error: err.message };
      }
    }
  }

  return { success: false, error: 'Max attempts reached' };
}

/**
 * Send a test payload to Starlink.
 */
async function sendTestToStarlink(customPayload = null) {
  const samplePayload = customPayload || {
    id: 5500000000001,
    admin_graphql_api_id: 'gid://shopify/Order/5500000000001',
    name: '#TEST-0001',
    order_number: 1001,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    total_price: '199.00',
    subtotal_price: '199.00',
    total_tax: '0.00',
    currency: 'EGP',
    financial_status: 'paid',
    fulfillment_status: null,
    email: 'test@dopaconfirm.com',
    note: 'DopaConfirm test order',
    tags: '',
    token: 'dopaconfirm-test-token',
    gateway: 'cash_on_delivery',
    test: true,
    customer: {
      id: 1001,
      email: 'test@dopaconfirm.com',
      first_name: 'أحمد',
      last_name: 'محمد',
      phone: '+201012345678',
      orders_count: 1,
      state: 'enabled',
      total_spent: '199.00',
      default_address: {
        id: 2001,
        first_name: 'أحمد',
        last_name: 'محمد',
        address1: '5 شارع التحرير',
        address2: '',
        city: 'القاهرة',
        province: '',
        country: 'Egypt',
        zip: '11511',
        phone: '+201012345678',
        country_code: 'EG',
      },
    },
    billing_address: {
      first_name: 'أحمد',
      last_name: 'محمد',
      address1: '5 شارع التحرير',
      address2: '',
      city: 'القاهرة',
      province: '',
      country: 'Egypt',
      zip: '11511',
      phone: '+201012345678',
      country_code: 'EG',
    },
    shipping_address: {
      first_name: 'أحمد',
      last_name: 'محمد',
      address1: '5 شارع التحرير',
      address2: '',
      city: 'القاهرة',
      province: '',
      country: 'Egypt',
      zip: '11511',
      phone: '+201012345678',
      country_code: 'EG',
    },
    line_items: [
      {
        id: 10001,
        variant_id: 20001,
        title: 'منتج تجريبي',
        name: 'منتج تجريبي - M',
        quantity: 1,
        sku: 'TEST-001-M',
        variant_title: 'M',
        fulfillable_quantity: 1,
        fulfillment_status: null,
        price: '199.00',
        total_discount: '0.00',
        vendor: 'DopaConfirm Test',
        product_id: 30001,
        requires_shipping: true,
        taxable: false,
        gift_card: false,
        properties: [],
        tax_lines: [],
        discount_allocations: [],
      },
    ],
    shipping_lines: [
      {
        id: 40001,
        code: 'Standard',
        price: '0.00',
        title: 'توصيل مجاني',
        carrier_identifier: null,
        requested_fulfillment_service_id: null,
        tax_lines: [],
        discount_allocations: [],
      },
    ],
    tax_lines: [],
    discount_codes: [],
    discount_applications: [],
    note_attributes: [],
    payment_gateway_names: ['cash_on_delivery'],
  };

  return sendOrderToStarlink(samplePayload);
}

module.exports = { sendOrderToStarlink, sendTestToStarlink };

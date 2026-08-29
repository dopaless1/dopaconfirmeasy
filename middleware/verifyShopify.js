'use strict';

const crypto = require('crypto');

/**
 * Middleware to verify Shopify webhook HMAC-SHA256 signature.
 *
 * If SHOPIFY_WEBHOOK_SECRET is not set or SHOPIFY_SKIP_HMAC=true → skip verification (dev mode).
 */
function verifyShopifyWebhook(req, res, next) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  // ── Dev/bypass mode ──────────────────────────────────────────────────────────
  // If secret is missing OR explicitly disabled → pass through (log warning)
  if (!secret || process.env.SHOPIFY_SKIP_HMAC === 'true') {
    console.warn('[verifyShopify] ⚠️  HMAC verification SKIPPED (no secret or SHOPIFY_SKIP_HMAC=true)');
    return next();
  }

  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  // Log all incoming headers for debugging
  console.log('[verifyShopify] Headers:', {
    topic:    req.get('X-Shopify-Topic'),
    shop:     req.get('X-Shopify-Shop-Domain'),
    hmac:     hmacHeader ? hmacHeader.substring(0, 10) + '...' : 'MISSING',
    bodyLen:  req.rawBody ? req.rawBody.length : 0,
  });

  if (!hmacHeader) {
    console.warn('[verifyShopify] ❌ Missing X-Shopify-Hmac-Sha256 header');
    return res.status(401).json({ error: 'Missing HMAC header' });
  }

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    console.warn('[verifyShopify] ❌ Raw body not available or empty');
    return res.status(400).json({ error: 'Raw body not available' });
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  // timingSafeEqual requires same-length buffers
  const digestBuf = Buffer.from(digest, 'base64');
  const headerBuf = Buffer.from(hmacHeader, 'base64');

  let valid = false;
  try {
    if (digestBuf.length === headerBuf.length) {
      valid = crypto.timingSafeEqual(digestBuf, headerBuf);
    }
  } catch (e) {
    console.error('[verifyShopify] timingSafeEqual error:', e.message);
    valid = false;
  }

  if (!valid) {
    console.warn('[verifyShopify] ❌ Invalid HMAC — computed:', digest.substring(0, 20) + '...');
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  console.log('[verifyShopify] ✅ HMAC valid');
  next();
}

module.exports = { verifyShopifyWebhook };

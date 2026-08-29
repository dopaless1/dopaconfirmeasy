'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { fetchShopifyProducts } = require('../services/shopify');

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/products', async (req, res) => {
  try {
    const products = await db.getProducts();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pulls the product list from Shopify and merges it locally — never
// overwrites cost fields the merchant already filled in.
router.post('/products/sync', async (req, res) => {
  try {
    const result = await fetchShopifyProducts();
    if (!result.success) return res.status(500).json({ success: false, error: result.error });
    await db.syncProductsFromShopify(result.products);
    const products = await db.getProducts();
    res.json({ success: true, products, syncedCount: result.products.length });
  } catch (err) {
    console.error('[Products] Sync error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { baseCost, packagingCost, extraCost } = req.body;
    await db.updateProductCosts(req.params.id, {
      baseCost: parseFloat(baseCost) || 0,
      packagingCost: parseFloat(packagingCost) || 0,
      extraCost: parseFloat(extraCost) || 0,
    });
    const products = await db.getProducts();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/profit/products/:id/message — per-product custom WhatsApp text + image
router.put('/products/:id/message', async (req, res) => {
  try {
    const { messageText, messageImageBase64 } = req.body;
    await db.updateProductMessage(req.params.id, { messageText, messageImageBase64 });
    const products = await db.getProducts();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SHIPPING RATES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/shipping-rates', async (req, res) => {
  try {
    const rates = await db.getShippingRates();
    res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/shipping-rates/:id', async (req, res) => {
  try {
    const { price } = req.body;
    if (price === undefined || isNaN(parseFloat(price))) {
      return res.status(400).json({ success: false, error: 'سعر غير صالح' });
    }
    await db.updateShippingRate(req.params.id, parseFloat(price));
    const rates = await db.getShippingRates();
    res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NET PROFIT REPORT
// ═══════════════════════════════════════════════════════════════════════════

router.get('/report', async (req, res) => {
  try {
    let { from, to, range } = req.query;

    if (!from || !to) {
      const now = new Date();
      const end = now.toISOString();
      let start;
      if (range === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      } else if (range === 'week') {
        start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (range === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      } else {
        // Default: last 30 days
        start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      }
      from = start;
      to = end;
    }

    const report = await db.getProfitReport(from, to);
    res.json({ success: true, report, from, to });
  } catch (err) {
    console.error('[Profit] Report error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/profit/export/pdf — printable summary report
router.get('/export/pdf', async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    let { from, to, range } = req.query;

    if (!from || !to) {
      const now = new Date();
      to = now.toISOString();
      from = range === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
           : range === 'week'  ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
           : range === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
           : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    const report = await db.getProfitReport(from, to);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="profit-report.pdf"');

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    // NOTE: PDFKit's built-in fonts don't support Arabic glyphs, so this
    // report uses English labels to guarantee it renders correctly
    // wherever it's opened.
    doc.fontSize(20).text('DopaConfirm — Net Profit Report', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666').text(
      `Period: ${new Date(from).toLocaleDateString('en-GB')} - ${new Date(to).toLocaleDateString('en-GB')}`,
      { align: 'center' }
    );
    doc.moveDown(1.5);

    const rows = [
      ['Total Revenue', `${report.totalRevenue.toFixed(2)} EGP`],
      ['Product Cost', `${report.totalProductCost.toFixed(2)} EGP`],
      ['Shipping Cost', `${report.totalShippingCost.toFixed(2)} EGP`],
      ['Net Profit', `${report.netProfit.toFixed(2)} EGP`],
      ['Order Count', `${report.orderCount}`],
      ['Unmatched Governorate', `${report.unmatchedGovernorateCount}`],
    ];

    doc.fontSize(12);
    rows.forEach(([label, value], i) => {
      const y = doc.y;
      if (i === 3) doc.fillColor('#00a650').font('Helvetica-Bold');
      else { doc.fillColor('#000').font('Helvetica'); }
      doc.text(label, 60, y, { continued: false });
      doc.text(value, 400, y);
      doc.moveDown(0.6);
    });

    doc.moveDown(1);
    doc.fontSize(9).fillColor('#999').text(
      `Generated: ${new Date().toLocaleString('en-GB')}`,
      { align: 'right' }
    );

    doc.end();
  } catch (err) {
    console.error('[Profit] PDF export error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

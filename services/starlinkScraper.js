'use strict';

const axios = require('axios');
const db = require('../database/db');
const { fetchShopifyOrder, getAccessToken, markOrderAsPaid, fulfillShopifyOrder, updateShopifyOrderTags } = require('./shopify');

/**
 * Scrape Starlink dashboard for latest order statuses
 */
async function syncStarlinkOrders(username, password) {
  const loginUrl = 'https://starlinkdelivery.com/';
  const ordersUrl = 'https://starlinkdelivery.com/clientorders';
  
  try {
    // 1. Get login page to grab ViewState
    const getRes = await axios.get(loginUrl, { validateStatus: () => true });
    const html = getRes.data;
    const cookies = getRes.headers['set-cookie'] || [];
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

    const viewState = html.match(/id="__VIEWSTATE" value="([^"]+)"/)?.[1];
    const viewStateGen = html.match(/id="__VIEWSTATEGENERATOR" value="([^"]+)"/)?.[1];
    const eventValidation = html.match(/id="__EVENTVALIDATION" value="([^"]+)"/)?.[1];

    if (!viewState || !eventValidation) {
      throw new Error('Failed to extract ASP.NET login tokens.');
    }

    // 2. Prepare POST payload
    const params = new URLSearchParams();
    params.append('__VIEWSTATE', viewState);
    params.append('__VIEWSTATEGENERATOR', viewStateGen);
    params.append('__EVENTVALIDATION', eventValidation);
    params.append('__EVENTTARGET', 'LnkLogin');
    params.append('__EVENTARGUMENT', '');
    params.append('Txt_Emp_User_Login', username);
    params.append('Txt_Emp_Pass', password);

    // 3. Send Login POST
    const postRes = await axios.post(loginUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0'
      },
      maxRedirects: 0,
      validateStatus: () => true
    });

    // Check for success (usually 302 redirect to clienthome)
    if (postRes.status !== 302 && !postRes.data.includes('clienthome')) {
      throw new Error('Invalid credentials or login failed.');
    }

    const loginCookies = postRes.headers['set-cookie'] || [];
    const authCookieStr = loginCookies.map(c => c.split(';')[0]).join('; ') || cookieStr;

    // 4. Fetch Orders Page
    const ordersRes = await axios.get(ordersUrl, {
      headers: { 'Cookie': authCookieStr, 'User-Agent': 'Mozilla/5.0' }
    });

    const ordersHtml = ordersRes.data;

    // 5. Parse HTML Table
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    
    let match;
    let scrapedOrders = [];
    
    while ((match = trRegex.exec(ordersHtml)) !== null) {
      const trHtml = match[1];
      let tds = [];
      let tdMatch;
      while ((tdMatch = tdRegex.exec(trHtml)) !== null) {
        const text = tdMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        tds.push(text);
      }
      
      // Starlink table format: index 2 = order number, index 15 = status
      if (tds.length > 10) {
        const orderNumberStr = tds[2];
        const statusText = tds[15] || '';
        
        let mappedStatus = null;
        if (statusText.includes('تم التسليم')) {
          mappedStatus = 'delivered';
        } else if (statusText.includes('مرتجع')) {
          mappedStatus = 'cancelled';
        } else if (statusText.includes('في الشحن') || statusText.includes('قيد عملية الشحن')) {
          mappedStatus = 'shipping_sent';
        }
        
        if (orderNumberStr && mappedStatus) {
          // Extract numeric part if needed, e.g. "1028"
          const orderNumber = orderNumberStr.replace(/[^0-9]/g, '');
          if (orderNumber) {
            scrapedOrders.push({ orderNumber, mappedStatus });
          }
        }
      }
    }

    // 6. Sync with Database
    let updatedCount = 0;
    const allOrdersRaw = await db.getAllOrders();
    // Turso returns rows as array-like objects — convert to plain array
    const allOrders = Array.isArray(allOrdersRaw) ? allOrdersRaw : Array.from(allOrdersRaw);

    for (const scraped of scrapedOrders) {
      const localOrder = allOrders.find(o => String(o.order_number).includes(scraped.orderNumber));
      
      if (localOrder) {
        // Update local DB if status changed
        if (localOrder.status !== scraped.mappedStatus && localOrder.status !== 'delivered') {
          await db.updateOrderStatus(localOrder.shopify_order_id, scraped.mappedStatus);
          updatedCount++;
          
          if (global.broadcastSSE) {
            global.broadcastSSE({ type: 'status_update', orderId: localOrder.id, status: scraped.mappedStatus });
          }
          
          // Update Shopify natively (ONLY when status changes!)
          try {
            // 1. Tags
            await updateShopifyOrderTags(localOrder.shopify_order_id, scraped.mappedStatus);

            // 2. Fulfill and Pay (Only when Delivered)
            if (scraped.mappedStatus === 'delivered') {
              await fulfillShopifyOrder(localOrder.shopify_order_id);
              await markOrderAsPaid(localOrder.shopify_order_id);
              
              // Send Review Request WhatsApp if not sent yet
              if (!localOrder.review_sent_at) {
                const { sendReviewRequest } = require('./whatsapp');
                console.log(`[StarlinkScraper] Sending review request to ${localOrder.customer_phone}`);
                const reviewRes = await sendReviewRequest(localOrder);
                if (reviewRes.success) {
                  await db.markOrderReviewSent(localOrder.shopify_order_id);
                  // Also add review request sent tag
                  await updateShopifyOrderTags(localOrder.shopify_order_id, 'review_sent');
                }
              }
            }

            // 3. Cancel Order (If returned)
            const { cancelShopifyOrder } = require('./shopify');
            if (scraped.mappedStatus === 'cancelled') {
              await cancelShopifyOrder(localOrder.shopify_order_id, 'inventory');
            }
            
          } catch (shopifyErr) {
            console.error(`[Scraper] Failed to update Shopify native status for ${scraped.orderNumber}:`, shopifyErr.message);
          }
        }
      }
    }

    return { success: true, count: updatedCount, totalScraped: scrapedOrders.length };

  } catch (err) {
    console.error('[Scraper Error]:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { syncStarlinkOrders };

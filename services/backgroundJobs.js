'use strict';

/**
 * DopaConfirm — Background Jobs
 * ─────────────────────────────
 * 1. Auto-Retry: كل 15 دقيقة يحاول يبعت تاني للأوردرات الفاشلة (max 3 محاولات)
 * 2. Order Timeout: كل 10 دقايق يشوف الأوردرات اللي ما ردوش ويبعت reminder أو يعملها needs_follow_up
 */

const db = require('../database/db');

// ─── Helper: اقرأ feature toggle من الـ DB ──────────────────────────────────
async function isEnabled(key) {
  const val = await db.getSetting(key).catch(() => null);
  // default values لو مش متحددة
  if (val === null) {
    if (key === 'FEATURE_AUTO_RETRY') return true;
    if (key === 'FEATURE_ORDER_TIMEOUT') return true;
    return false;
  }
  return val === 'true';
}

async function getSetting(key, defaultVal) {
  const val = await db.getSetting(key).catch(() => null);
  return val !== null ? val : defaultVal;
}

// ─── Helper: إرسال تنبيه لصاحب المتجر ──────────────────────────────────────
async function notifyOwner(message) {
  try {
    const ownerPhone = await getSetting('OWNER_ALERT_PHONE', '201068093260');
    const { sendWhatsAppMessageWithRetry } = require('./whatsapp');
    const timestamp = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
    await sendWhatsAppMessageWithRetry(ownerPhone, `🚨 *DopaConfirm Alert*\n${message}\n\n🕐 ${timestamp}`);
  } catch (e) {
    console.error('[BgJobs] Failed to notify owner:', e.message);
  }
}

// ─── Job 1: Auto-Retry ────────────────────────────────────────────────────────
// الأوردرات اللي status = whatsapp_failed ولها أقل من 3 محاولات — يحاول تاني
async function runAutoRetry() {
  if (!await isEnabled('FEATURE_AUTO_RETRY')) return;

  try {
    const client = db.getDb();
    // جيب الأوردرات الفاشلة اللي عندها retry_count < 3 أو retry_count NULL
    const res = await client.execute({
      sql: `SELECT * FROM orders 
            WHERE status = 'whatsapp_failed' 
            AND (CAST(COALESCE(json_extract(notes, '$.retry_count'), 0) AS INTEGER) < 3)
            ORDER BY created_at ASC
            LIMIT 20`,
      args: []
    });

    if (res.rows.length === 0) return;
    console.log(`[AutoRetry] Found ${res.rows.length} failed order(s) to retry`);

    const { sendWhatsAppMessageWithRetry, sendPollWithRetry, formatMessage, getMessageTemplate } = require('./whatsapp');
    const { updateSourceStatus } = require('./sourceAdapter');

    const template = await getMessageTemplate();
    if (!template) {
      console.warn('[AutoRetry] No message template configured — skipping');
      return;
    }

    for (const order of res.rows) {
      try {
        // قرأ retry_count من notes JSON
        let notes = {};
        try { notes = JSON.parse(order.notes || '{}'); } catch {}
        const retryCount = (notes.retry_count || 0) + 1;

        console.log(`[AutoRetry] Order ${order.order_number} — attempt ${retryCount}/3`);

        const msgText = formatMessage(template, order);
        const rText = await sendWhatsAppMessageWithRetry(order.customer_phone, msgText, true);
        const pollOptions = [{ optionName: '✅ تأكيد الطلب' }, { optionName: '❌ تعديل أو إلغاء' }];
        const rPoll = await sendPollWithRetry(order.customer_phone, 'برجاء اختيار تأكيد الطلب من الخيارات بالأسفل لتسريع عملية الشحن:', pollOptions);

        notes.retry_count = retryCount;
        notes.last_retry_at = new Date().toISOString();

        if (rText.success || rPoll.success) {
          notes.retry_success_at = new Date().toISOString();
          await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_sent', { whatsapp_sent_at: new Date().toISOString() });
          await db.upsertWhatsappSession(order.customer_phone, order.shopify_order_id);
          updateSourceStatus(order, 'whatsapp_sent').catch(() => {});
          console.log(`[AutoRetry] ✅ Order ${order.order_number} — retry succeeded`);
        } else {
          if (retryCount >= 3) {
            // وصل الحد الأقصى — alert صاحب المتجر
            console.warn(`[AutoRetry] ❌ Order ${order.order_number} — max retries reached`);
            await notifyOwner(`❌ فشل إرسال واتساب بعد 3 محاولات\nالأوردر: ${order.order_number}\nالعميل: ${order.customer_name}\nالهاتف: ${order.customer_phone}\n👉 راجع الداشبورد`);
          }
        }

        // حدّث notes مرة واحدة بس في الآخر (سواء نجح أو فشل)
        await db.updateOrderNotes(order.id, JSON.stringify(notes));


      } catch (e) {
        console.error(`[AutoRetry] Error on order ${order.order_number}:`, e.message);
      }

      // استنى شوية بين كل أوردر عشان ما تضغطش على الـ API
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error('[AutoRetry] Job error:', e.message);
  }
}

// ─── Job 2: Order Timeout + Reminder ─────────────────────────────────────────
// الأوردرات اللي status = whatsapp_sent ولحد دلوقتي ما ردوش
async function runOrderTimeout() {
  if (!await isEnabled('FEATURE_ORDER_TIMEOUT')) return;

  try {
    const remindHrs = parseFloat(await getSetting('FEATURE_TIMEOUT_REMIND_HRS', '6'));
    const finalHrs  = parseFloat(await getSetting('FEATURE_TIMEOUT_FINAL_HRS', '12'));

    const client = db.getDb();
    const res = await client.execute({
      sql: `SELECT * FROM orders 
            WHERE status = 'whatsapp_sent'
            AND whatsapp_sent_at IS NOT NULL
            ORDER BY whatsapp_sent_at ASC
            LIMIT 50`,
      args: []
    });

    if (res.rows.length === 0) return;

    const now = Date.now();
    const { sendWhatsAppMessageWithRetry } = require('./whatsapp');
    const { updateSourceStatus } = require('./sourceAdapter');

    for (const order of res.rows) {
      try {
        let notes = {};
        try { notes = JSON.parse(order.notes || '{}'); } catch {}

        const sentAt = new Date(order.whatsapp_sent_at).getTime();
        const hoursElapsed = (now - sentAt) / (1000 * 60 * 60);

        // ─── المرحلة 1: Reminder ───────────────────────────────────────────
        if (hoursElapsed >= remindHrs && !notes.reminder_sent_at) {
          console.log(`[Timeout] Order ${order.order_number} — sending reminder (${hoursElapsed.toFixed(1)}h elapsed)`);

          const reminderMsg = `👋 مرحباً ${order.customer_name || ''}!\n\nلسه مستنيين تأكيدك على طلبك رقم *${order.order_number}* 😊\n\nرد بـ *نعم* للتأكيد أو *لا* للإلغاء.`;
          const r = await sendWhatsAppMessageWithRetry(order.customer_phone, reminderMsg);

          notes.reminder_sent_at = new Date().toISOString();
          await db.updateOrderNotes(order.id, JSON.stringify(notes));

          if (r.success) {
            console.log(`[Timeout] ✅ Reminder sent for order ${order.order_number}`);
          } else {
            console.warn(`[Timeout] ⚠️ Reminder failed for order ${order.order_number}`);
          }
        }

        // ─── المرحلة 2: Final Timeout → needs_follow_up ───────────────────
        if (hoursElapsed >= finalHrs && !notes.timeout_at) {
          console.log(`[Timeout] Order ${order.order_number} — marking needs_follow_up (${hoursElapsed.toFixed(1)}h elapsed)`);

          notes.timeout_at = new Date().toISOString();
          await db.updateOrderNotes(order.id, JSON.stringify(notes));
          await db.updateOrderStatus(order.shopify_order_id, 'needs_follow_up');
          updateSourceStatus(order, 'needs_follow_up').catch(() => {});

          await notifyOwner(`⏳ أوردر بدون رد منذ ${finalHrs} ساعة\nالأوردر: ${order.order_number}\nالعميل: ${order.customer_name}\nالهاتف: ${order.customer_phone}\n👉 يحتاج متابعة يدوية`);
        }

      } catch (e) {
        console.error(`[Timeout] Error on order ${order.order_number}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Timeout] Job error:', e.message);
  }
}

// ─── Job 3: Daily Report ──────────────────────────────────────────────────────
async function runDailyReport() {
  if (!await isEnabled('FEATURE_DAILY_REPORT')) return;

  try {
    const stats = await db.getOrderStats();
    const ownerPhone = await getSetting('OWNER_ALERT_PHONE', '201068093260');
    const { sendWhatsAppMessageWithRetry } = require('./whatsapp');

    const today = new Date().toLocaleDateString('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const report = `📊 *تقرير DopaLess — ${today}*\n\n` +
      `📦 إجمالي الأوردرات: ${stats.total || 0}\n` +
      `✅ مؤكد: ${stats.confirmed || 0}\n` +
      `🚚 أُرسل للشحن: ${stats.shipping_sent || 0}\n` +
      `📬 تم التسليم: ${stats.delivered || 0}\n` +
      `⏳ في الانتظار: ${stats.pending || 0}\n` +
      `🚫 ملغي: ${stats.cancelled || 0}\n` +
      `❌ فشل واتساب: ${stats.whatsapp_failed || 0}`;

    await sendWhatsAppMessageWithRetry(ownerPhone, report);
    console.log('[DailyReport] ✅ Report sent');
  } catch (e) {
    console.error('[DailyReport] Error:', e.message);
  }
}

// ─── Job 4: Task Reminders (per-worker WhatsApp) ─────────────────────────────
// Checks tasks due within the next TASK_REMIND_HOURS_AHEAD hours and texts
// each ASSIGNED worker directly on their own phone — not the shared owner
// alert number — so "المهمة دي ليك" actually reaches the right person.
async function runTaskReminders() {
  try {
    const hoursAhead = parseFloat(await getSetting('TASK_REMIND_HOURS_AHEAD', '24'));
    const dueTasks = await db.getTasksNeedingReminder(hoursAhead);
    if (dueTasks.length === 0) return;

    const { sendWhatsAppMessageWithRetry } = require('./whatsapp');
    const workers = await db.getWorkers();
    const workerById = new Map(workers.map(w => [w.id, w]));

    const PRIORITY_LABEL = { high: '🔴 عالية', med: '🟡 متوسطة', low: '🟢 منخفضة' };

    for (const task of dueTasks) {
      let assigneeIds = [];
      try { assigneeIds = JSON.parse(task.assignee_worker_ids || '[]'); } catch {}

      if (assigneeIds.length === 0) {
        // No specific worker assigned — nothing to text, just mark so we
        // don't keep re-checking this task every job cycle forever.
        await db.markTaskReminderSent(task.id);
        continue;
      }

      const dueStr = new Date(task.due_date).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });
      const message = `⏰ *تذكير بمهمة*\n\n📝 ${task.text}\n📅 الموعد: ${dueStr}\nالأولوية: ${PRIORITY_LABEL[task.priority] || task.priority}`;

      for (const workerId of assigneeIds) {
        const worker = workerById.get(workerId);
        if (!worker) continue;
        try {
          await sendWhatsAppMessageWithRetry(worker.phone, message);
          console.log(`[TaskReminder] ✅ Sent to ${worker.name} (${worker.phone}) for task #${task.id}`);
        } catch (e) {
          console.error(`[TaskReminder] Failed to notify ${worker.name}:`, e.message);
        }
      }

      await db.markTaskReminderSent(task.id);
    }
  } catch (e) {
    console.error('[TaskReminder] Job error:', e.message);
  }
}

// ─── Job 5: Scheduled WhatsApp Send ───────────────────────────────────────────
// الأوردرات اللي في notes.whatsapp_send_after وحان وقت بعتها
// (بتتستخدم لما يكون WHATSAPP_DELAY_HOURS > 0)
async function runScheduledWhatsApp() {
  try {
    const client = db.getDb();
    const now = new Date().toISOString();

    // Find pending orders that have a scheduled send time in the past
    const res = await client.execute({
      sql: `SELECT * FROM orders
            WHERE status = 'pending_confirmation'
            AND deleted_at IS NULL
            AND whatsapp_sent_at IS NULL
            AND json_extract(notes, '$.whatsapp_send_after') IS NOT NULL
            AND json_extract(notes, '$.whatsapp_send_after') <= ?
            ORDER BY created_at ASC
            LIMIT 20`,
      args: [now],
    });

    if (res.rows.length === 0) return;
    console.log(`[ScheduledWA] Found ${res.rows.length} order(s) ready to send`);

    const { sendWhatsAppMessageWithRetry, sendPollWithRetry, formatMessage, getMessageTemplate } = require('./whatsapp');
    const { updateShopifyOrderTags } = require('./shopify');

    for (const order of res.rows) {
      try {
        // Clear the schedule flag so it doesn't get picked up again
        let notes = {};
        try { notes = JSON.parse(order.notes || '{}'); } catch {}
        delete notes.whatsapp_send_after;
        await db.updateOrderNotes(order.id, JSON.stringify(notes));

        // Use the same sendConfirmationWhatsApp logic
        const template = await getMessageTemplate();
        const { updateSourceStatus } = require('./sourceAdapter');
        if (!template) {
          await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_failed');
          updateSourceStatus(order, 'whatsapp_failed').catch(() => {});
          continue;
        }

        const msgText = formatMessage(template, order);
        const rText = await sendWhatsAppMessageWithRetry(order.customer_phone, msgText, true);
        const pollOptions = [{ optionName: '✅ تأكيد الطلب' }, { optionName: '❌ تعديل أو إلغاء' }];
        const rPoll = await sendPollWithRetry(order.customer_phone, 'برجاء اختيار تأكيد الطلب من الخيارات بالأسفل لتسريع عملية الشحن:', pollOptions);

        const sentAt = new Date().toISOString();
        if (rText.success || rPoll.success) {
          await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_sent', { whatsapp_sent_at: sentAt });
          await db.upsertWhatsappSession(order.customer_phone, order.shopify_order_id);
          updateSourceStatus(order, 'whatsapp_sent').catch(() => {});
          console.log(`[ScheduledWA] ✅ Sent to order ${order.order_number}`);
        } else {
          await db.updateOrderStatus(order.shopify_order_id, 'whatsapp_failed', { whatsapp_sent_at: sentAt });
          updateSourceStatus(order, 'whatsapp_failed').catch(() => {});
          console.warn(`[ScheduledWA] ❌ Failed to send to order ${order.order_number}`);
        }

        // Brief pause between sends
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`[ScheduledWA] Error on order ${order.order_number}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[ScheduledWA] Job error:', e.message);
  }
}

// ─── Job 6: Speedaf Tracking (every 30 mins) ─────────────────────────────────
async function runSpeedafTracking() {
  try {
    const { trackAllActiveOrders } = require('./speedaf');
    await trackAllActiveOrders();
  } catch (e) {
    console.error('[SpeedafTracking] Job error:', e.message);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
function startBackgroundJobs() {
  console.log('[BgJobs] 🚀 Starting background jobs...');

  // Auto-Retry: كل 15 دقيقة
  setInterval(runAutoRetry, 15 * 60 * 1000);
  setTimeout(runAutoRetry, 2 * 60 * 1000);

  // Order Timeout: كل 10 دقايق
  setInterval(runOrderTimeout, 10 * 60 * 1000);
  setTimeout(runOrderTimeout, 3 * 60 * 1000);

  // Daily Report: كل يوم الساعة 8 صباحاً
  scheduleDailyAt(8, 0, runDailyReport);

  // Scheduled WhatsApp: كل دقيقة (لفحص الرسائل المؤجلة)
  setInterval(runScheduledWhatsApp, 1 * 60 * 1000);
  setTimeout(runScheduledWhatsApp, 15 * 1000);

  // Speedaf Tracking: كل 30 دقيقة
  setInterval(runSpeedafTracking, 30 * 60 * 1000);
  setTimeout(runSpeedafTracking, 4 * 60 * 1000);

  console.log('[BgJobs] ✅ Auto-Retry (15m) | Order Timeout (10m) | Daily Report (8AM) | Scheduled WA (1m) | Speedaf Tracking (30m)');
}

// بيحسب كم ms باقي لحد الساعة المحددة بتوقيت القاهرة (Africa/Cairo) ويشغل الـ job
function scheduleDailyAt(cairoTargetHour, cairoTargetMinute, fn) {
  function msUntilNext() {
    const now = new Date();
    // احسب وقت القاهرة الحالي
    const cairoTimeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Cairo',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false
    });
    
    const parts = cairoTimeFormatter.formatToParts(now);
    const p = {};
    for (const part of parts) p[part.type] = part.value;

    const currentYear = parseInt(p.year);
    const currentMonth = parseInt(p.month) - 1; // 0-indexed
    const currentDay = parseInt(p.day);
    const currentHour = parseInt(p.hour);
    const currentMinute = parseInt(p.minute);

    // احسب الفرق بالساعات بين UTC والقاهرة حالياً
    const cairoDateObj = new Date(Date.UTC(currentYear, currentMonth, currentDay, currentHour, currentMinute, parseInt(p.second)));
    const cairoOffsetMs = cairoDateObj.getTime() - now.getTime();

    // تاريخ الهدف التالي بتوقيت القاهرة
    let targetCairoDay = currentDay;
    if (currentHour > cairoTargetHour || (currentHour === cairoTargetHour && currentMinute >= cairoTargetMinute)) {
      targetCairoDay += 1;
    }

    const targetDateCairo = new Date(Date.UTC(currentYear, currentMonth, targetCairoDay, cairoTargetHour, cairoTargetMinute, 0));
    // حوّله للـ epoch الحقيقي بطرح الـ offset
    const realTargetTime = targetDateCairo.getTime() - cairoOffsetMs;
    const diff = realTargetTime - now.getTime();

    console.log(`[DailyReport] ⏰ Next daily report scheduled in ${Math.round(diff / 60000)} minutes (at 08:00 AM Cairo Time)`);
    return Math.max(diff, 1000);
  }

  setTimeout(function tick() {
    fn();
    setTimeout(tick, msUntilNext());
  }, msUntilNext());
}

module.exports = { startBackgroundJobs, runAutoRetry, runOrderTimeout, runDailyReport, runScheduledWhatsApp, runSpeedafTracking };


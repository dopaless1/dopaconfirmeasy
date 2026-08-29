'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database/db');

// ═══════════════════════════════════════════════════════════════════════════
// WORKERS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/workers', async (req, res) => {
  try {
    const workers = await db.getWorkers();
    res.json({ success: true, workers });
  } catch (err) {
    console.error('[Workers] GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/workers', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, error: 'الاسم ورقم التليفون مطلوبين' });
    const cleanPhone = String(phone).replace(/\D/g, '');
    await db.addWorker(name.trim(), cleanPhone);
    const workers = await db.getWorkers();
    res.json({ success: true, workers });
  } catch (err) {
    console.error('[Workers] POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/workers/:id', async (req, res) => {
  try {
    await db.deleteWorker(req.params.id);
    const workers = await db.getWorkers();
    res.json({ success: true, workers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/tasks', async (req, res) => {
  try {
    const rows = await db.getTasks();
    const tasks = rows.map(t => ({
      ...t,
      done: !!t.done,
      assigneeWorkerIds: JSON.parse(t.assignee_worker_ids || '[]'),
    }));
    res.json({ success: true, tasks });
  } catch (err) {
    console.error('[Tasks] GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PRIORITY_LABEL = { high: '🔴 عالية', med: '🟡 متوسطة', low: '🟢 منخفضة' };

router.post('/tasks', async (req, res) => {
  try {
    const { text, priority, dueDate, assigneeWorkerIds } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'اكتب نص المهمة' });
    await db.addTask({ text: text.trim(), priority, dueDate: dueDate || null, assigneeWorkerIds });
    const rows = await db.getTasks();
    const tasks = rows.map(t => ({ ...t, done: !!t.done, assigneeWorkerIds: JSON.parse(t.assignee_worker_ids || '[]') }));
    res.json({ success: true, tasks });

    if (Array.isArray(assigneeWorkerIds) && assigneeWorkerIds.length > 0) {
      notifyWorkersOfNewTask({ text: text.trim(), priority, dueDate }, assigneeWorkerIds)
        .catch(e => console.error('[Tasks] New-task notification error:', e.message));
    }
  } catch (err) {
    console.error('[Tasks] POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function notifyWorkersOfNewTask(task, assigneeWorkerIds) {
  const { sendWhatsAppMessageWithRetry } = require('../services/whatsapp');
  const workers = await db.getWorkers();
  const workerById = new Map(workers.map(w => [w.id, w]));

  const dueStr = task.dueDate
    ? new Date(task.dueDate).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const message = `📌 *مهمة جديدة ليك*\n\n📝 ${task.text}\n${dueStr ? `📅 الموعد: ${dueStr}\n` : ''}الأولوية: ${PRIORITY_LABEL[task.priority] || task.priority}`;

  for (const workerId of assigneeWorkerIds) {
    const worker = workerById.get(workerId);
    if (!worker) continue;
    try {
      await sendWhatsAppMessageWithRetry(worker.phone, message);
      console.log(`[Tasks] ✅ New-task notification sent to ${worker.name} (${worker.phone})`);
    } catch (e) {
      console.error(`[Tasks] Failed to notify ${worker.name}:`, e.message);
    }
  }
}

router.put('/tasks/:id/toggle', async (req, res) => {
  try {
    const { done } = req.body;
    await db.toggleTask(req.params.id, done);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await db.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tasks/clear-done', async (req, res) => {
  try {
    await db.clearDoneTasks();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLIERS (server-side, shared across everyone using the dashboard)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/suppliers', async (req, res) => {
  try {
    const groups = await db.getSupplierGroups();
    res.json({ success: true, groups });
  } catch (err) {
    console.error('[Suppliers] GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/suppliers/groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'اكتب اسم المجموعة' });
    await db.addSupplierGroup(name.trim());
    const groups = await db.getSupplierGroups();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/suppliers/groups/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'اكتب اسم المجموعة' });
    await db.renameSupplierGroup(req.params.id, name.trim());
    const groups = await db.getSupplierGroups();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/suppliers/groups/:id', async (req, res) => {
  try {
    await db.deleteSupplierGroup(req.params.id);
    const groups = await db.getSupplierGroups();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/suppliers', async (req, res) => {
  try {
    const { groupId, name, product, phone, price, notes } = req.body;
    if (!groupId || !name || !name.trim()) return res.status(400).json({ success: false, error: 'بيانات ناقصة' });
    await db.addSupplier({ groupId, name: name.trim(), product, phone, price, notes });
    const groups = await db.getSupplierGroups();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/suppliers/:id', async (req, res) => {
  try {
    await db.deleteSupplier(req.params.id);
    const groups = await db.getSupplierGroups();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

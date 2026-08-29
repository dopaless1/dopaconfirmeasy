'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database/db');

// ═══════════════════════════════════════════════════════════════════════════
// FOLDERS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/folders', async (req, res) => {
  try {
    const folders = await db.getNoteFolders();
    const notes = await db.getNotes();
    res.json({ success: true, folders, notes });
  } catch (err) {
    console.error('[Notes] GET folders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/folders', async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'اكتب اسم المجلد' });
    const id = await db.addNoteFolder(name.trim(), parentId || null);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/folders/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'اكتب اسم المجلد' });
    await db.renameNoteFolder(req.params.id, name.trim());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/folders/:id', async (req, res) => {
  try {
    await db.deleteNoteFolderRecursive(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id', async (req, res) => {
  try {
    const note = await db.getNoteById(req.params.id);
    if (!note) return res.status(404).json({ success: false, error: 'Note not found' });
    res.json({ success: true, note });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { folderId } = req.body;
    if (!folderId) return res.status(400).json({ success: false, error: 'folderId required' });
    const id = await db.addNote(folderId);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, content } = req.body;
    await db.updateNote(req.params.id, title || '', content || '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id/move', async (req, res) => {
  try {
    const { folderId } = req.body;
    await db.moveNote(req.params.id, folderId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.deleteNote(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

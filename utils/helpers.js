'use strict';

// Phone normalization (currently duplicated in multiple files)
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/@c\.us|@s\.whatsapp\.net/g, '').replace(/^\+/, '').replace(/[^\d]/g, '');
}

// Format date to Cairo timezone
function formatCairoDate(date = new Date()) {
  return new Date(date).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
}

// Safe JSON parse with fallback
function safeJsonParse(str, fallback = {}) {
  try { return JSON.parse(str || JSON.stringify(fallback)); } catch { return fallback; }
}

// Truncate string for logging
function truncate(str, maxLen = 500) {
  if (!str) return '';
  const s = String(str);
  return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
}

module.exports = { normalizePhone, formatCairoDate, safeJsonParse, truncate };

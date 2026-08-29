(function () {
  const THEME_KEY = 'dopa_theme';

  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  const saved = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(saved);

  window.toggleDarkMode = function () {
    const current = localStorage.getItem(THEME_KEY) || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    updateToggleButtonLabel();
  };

  function updateToggleButtonLabel() {
    const btn = document.getElementById('dark-toggle-btn');
    if (!btn) return;
    const isDark = (localStorage.getItem(THEME_KEY) || 'light') === 'dark';
    btn.innerHTML = isDark ? '☀️ الوضع الفاتح' : '🌙 الوضع الداكن';
  }

  function injectToggleButton() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer || document.getElementById('dark-toggle-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'dark-toggle-btn';
    btn.className = 'dark-toggle-btn';
    btn.onclick = window.toggleDarkMode;
    footer.appendChild(btn);
    updateToggleButtonLabel();
  }

  document.addEventListener('DOMContentLoaded', injectToggleButton);
})();

'use strict';
(() => {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let mode = 'auto';
  try {
    mode = localStorage.getItem('sls-theme') || 'auto';
  } catch {}
  if (!['auto', 'light', 'dark'].includes(mode)) mode = 'auto';
  function hostTheme() {
    // Ingress shares the HA origin. Read only the host's theme preference.
    try {
      let host = window.parent;
      for (let depth = 0; host !== window && depth < 4; depth++) {
        const dark = host.document.querySelector('home-assistant')?.hass?.themes?.darkMode;
        if (typeof dark === 'boolean') return dark ? 'dark' : 'light';
        if (host === host.parent) break;
        host = host.parent;
      }
    } catch {
      /* Separate origins cannot expose the host theme. */
    }
    return media.matches ? 'dark' : 'light';
  }
  function apply() {
    const theme = mode === 'auto' ? hostTheme() : mode;
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
  }
  apply();
  media.addEventListener('change', apply);
  const select = document.querySelector('#theme-select');
  select.value = mode;
  select.addEventListener('change', () => {
    mode = select.value;
    try {
      localStorage.setItem('sls-theme', mode);
    } catch {}
    apply();
  });
  setInterval(() => {
    if (mode === 'auto' && !document.hidden) apply();
  }, 1500);
})();

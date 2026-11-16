(() => {
  'use strict';
  const storageKey = 'trajectory-theme';
  const eventName = 'trajectory-lab:theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  const isMode = value => ['light', 'dark', 'system'].includes(value);
  let localChoice;
  try { localChoice = localStorage.getItem(storageKey); } catch { /* The page can still change appearance. */ }
  let mode = isMode(localChoice) ? localChoice : 'system';
  let explicit = isMode(localChoice);

  function apply() {
    const dark = mode === 'dark' || (mode === 'system' && system.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.labTheme = root.dataset.theme;
    root.style.colorScheme = root.dataset.theme;
    const button = document.getElementById('theme');
    if (button) {
      button.textContent = dark ? '☀' : '☾';
      button.title = dark ? '切换到浅色' : '切换到深色';
    }
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.content = dark ? '#111722' : '#f5f7fb';
  }

  function setTheme(value) {
    if (!isMode(value)) return mode;
    explicit = true;
    if (value === mode) {
      try { localStorage.setItem(storageKey, value); } catch { /* Keep the in-memory mode. */ }
      return mode;
    }
    mode = value;
    try { localStorage.setItem(storageKey, value); } catch { /* Keep the in-memory mode. */ }
    apply();
    window.dispatchEvent(new CustomEvent(eventName, { detail: { mode } }));
    return mode;
  }

  window.LabUI = {
    eventName,
    theme: () => mode,
    setTheme,
    restoreTheme(value) { return explicit ? mode : setTheme(value); },
  };

  apply();
  system.addEventListener('change', () => { if (mode === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey || !isMode(event.newValue) || event.newValue === mode) return;
    explicit = true;
    mode = event.newValue;
    apply();
    window.dispatchEvent(new CustomEvent(eventName, { detail: { mode } }));
  });

  function mount() {
    const header = document.getElementById('lab-masthead');
    if (!header) return;
    const current = header.dataset.view;
    const views = [
      ['chat', '/featured/tools/chat/', 'Chat', '对话路径'],
      ['slate', '/featured/trajectory-lab/', '石板', '模型上下文'],
      ['trajectory', '/featured/trajectory-lab/trajectory.html', '轨迹', '归档分析'],
    ];
    const frame = document.createElement('div');
    frame.className = 'lab-masthead-inner';
    frame.innerHTML = '<a class="lab-brand" href="/featured/trajectory-lab/"><span class="lab-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>Trajectory Lab</span></a>';
    const nav = document.createElement('nav');
    nav.className = 'lab-view-nav';
    nav.setAttribute('aria-label', '轨迹视图');
    for (const [id, href, label, scope] of views) {
      const link = document.createElement('a');
      link.href = href;
      if (id === current) link.setAttribute('aria-current', 'page');
      const title = document.createElement('span');
      title.textContent = label;
      const detail = document.createElement('small');
      detail.textContent = scope;
      link.append(title, detail);
      nav.append(link);
    }
    const actions = document.createElement('div');
    actions.className = 'lab-global-actions';
    actions.innerHTML = '<a href="/featured.html">Featured <span aria-hidden="true">↗</span></a><button type="button" id="theme" class="lab-theme-toggle" aria-label="切换外观"></button>';
    frame.append(nav, actions);
    header.replaceChildren(frame);
    const button = document.getElementById('theme');
    button.onclick = () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();

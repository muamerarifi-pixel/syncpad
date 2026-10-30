// Applied before first paint so there is no light/dark flash
try {
  var t = localStorage.getItem('sp-theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (localStorage.getItem('sp-pin')) document.documentElement.classList.add('locked');
} catch (e) {}

// Applied before first paint so there is no light/dark flash
try {
  var t = localStorage.getItem('sp-theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // paper textures are gone: the app background is always plain
  localStorage.removeItem('sp-bg');
  delete document.documentElement.dataset.bg;
  var w = localStorage.getItem('sp-wall') || 'aurora';
  if (w !== 'none') document.documentElement.dataset.wall = w; else delete document.documentElement.dataset.wall;
  var color = dark ? '#16181e' : '#ffffff';
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) { m.removeAttribute('media'); m.content = color; }
  if (localStorage.getItem('sp-pin')) document.documentElement.classList.add('locked');
} catch (e) {}

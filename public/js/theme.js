// Applied before first paint so there is no light/dark flash
try {
  var t = localStorage.getItem('sp-theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  var bg = localStorage.getItem('sp-bg') || '';
  if (bg && bg !== 'none') document.documentElement.dataset.bg = bg;
  else delete document.documentElement.dataset.bg;
  var bgColors = {
    light: { classic: '#f2e8d0', smooth: '#f7f4f0', cotton: '#f3efe6', recycled: '#e6dfd0', lined: '#f6f7f9', linen: '#ece6da', washi: '#f5f1e8', vintage: '#e5d7b8', none: '#ffffff' },
    dark: { classic: '#262119', smooth: '#181b22', cotton: '#1e2028', recycled: '#2a261f', lined: '#181b22', linen: '#21252d', washi: '#1c2028', vintage: '#2a2015', none: '#16181e' }
  };
  var scheme = dark ? 'dark' : 'light';
  var color = (bg && bgColors[scheme][bg]) || bgColors[scheme].none;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) { m.removeAttribute('media'); m.content = color; }
  if (localStorage.getItem('sp-pin')) document.documentElement.classList.add('locked');
} catch (e) {}

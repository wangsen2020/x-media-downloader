const params = new URLSearchParams(location.search);
const lang = params.get('lang') || 'zh_CN';
const layout = params.get('layout') || 'landscape';
if (!/^[a-z]{2,3}(?:_[A-Za-z0-9]+)*$/.test(lang) || !['portrait','landscape'].includes(layout)) throw new Error('Invalid locale or layout');
const poster = document.getElementById('poster');
poster.classList.toggle('portrait',layout === 'portrait');
poster.classList.toggle('rtl',lang === 'ar');
document.documentElement.lang = lang.replaceAll('_','-');
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
const fonts = {zh_CN:'"Microsoft YaHei"',zh_TW:'"Microsoft JhengHei"',ja:'"Yu Gothic","Meiryo"',ko:'"Malgun Gothic"'};
poster.style.setProperty('--font',fonts[lang] || '"Segoe UI"');
const response = await fetch(`copy_${lang}.json`);
if (!response.ok) throw new Error(`Missing copy_${lang}.json (${response.status})`);
const copy = await response.json();
document.querySelectorAll('[data-copy]').forEach(el => {
  const key = el.dataset.copy;
  if (typeof copy[key] !== 'string') throw new Error(`Missing copy key: ${key}`);
  el.textContent = copy[key];
});
const iframe = document.querySelector('iframe');
const popupReady = new Promise((resolve,reject) => {
  iframe.addEventListener('load',() => {
    const child = iframe.contentWindow;
    const ready = () => {
      const body = child.document.body;
      const resize = () => {
        // Body bounds exclude the iframe viewport, unlike documentElement.scrollHeight.
        const height = Math.ceil(body.getBoundingClientRect().height);
        iframe.style.height = `${height}px`;
        if (layout === 'landscape') iframe.parentElement.style.top = `${(800-height*1.3)/2}px`;
      };
      resize(); new child.ResizeObserver(resize).observe(body); resolve();
    };
    if (child.popupReady) ready(); else child.addEventListener('popup-ready',ready,{once:true});
    child.addEventListener('error',event=>reject(new Error(event.message)),{once:true});
    child.addEventListener('unhandledrejection',event=>reject(event.reason),{once:true});
  },{once:true});
});
iframe.src = `popup_harness.html?lang=${encodeURIComponent(lang)}`;
await Promise.all([document.fonts.ready,popupReady,document.querySelector('.scene').decode()]);
function fit(el) {
  if (!el.getClientRects().length) return;
  let size = parseFloat(getComputedStyle(el).fontSize);
  const limit = el.classList.contains('headline2') ? el.parentElement.clientWidth : el.clientWidth;
  while (size > 10 && (el.scrollWidth > limit + 1 || el.scrollHeight > el.clientHeight + 1)) {
    el.style.fontSize = `${--size}px`;
  }
}
function fitStep(el) {
  if (!el.getClientRects().length) return;
  let size = parseFloat(getComputedStyle(el).fontSize);
  // Labels are single-line (white-space: nowrap), so only width can overflow.
  while (size > 18 && el.scrollWidth > el.clientWidth) {
    el.style.fontSize = `${--size}px`;
  }
}
function fitLine(el) {
  if (!el.getClientRects().length) return;
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (size > 22 && el.scrollWidth > el.clientWidth) {
    el.style.fontSize = `${--size}px`;
  }
  if (el.scrollWidth > el.clientWidth) {
    el.classList.add('fit-wrap');
    el.style.whiteSpace = 'normal';
  }
}
document.querySelectorAll('.headline,.badge').forEach(fit);
document.querySelectorAll('.step-label').forEach(fitStep);
document.querySelectorAll('.sub,.pill,.bullets li').forEach(fitLine);
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
document.body.dataset.ready = '1';

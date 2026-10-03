// Keep the extension markup, stylesheet, and module graph authoritative.
const extension = new URL('../../', location.href);
const lang = new URLSearchParams(location.search).get('lang') || 'zh_CN';
if (!/^[a-z]{2,3}(?:_[A-Za-z0-9]+)*$/.test(lang)) throw new Error('Invalid locale');
async function read(url, json = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return json ? response.json() : response.text();
}
const [messages, fallback, html] = await Promise.all([
  read(new URL(`_locales/${lang}/messages.json`, extension), true),
  read(new URL('_locales/en/messages.json', extension), true),
  read(new URL('src/popup/popup.html', extension))
]);
const catalog = Object.fromEntries(Object.entries({...fallback, ...messages}).map(([k,v]) => [k.toLowerCase(),v]));
export function getMessage(key, substitutions = []) {
  key = key.toLowerCase();
  const rtl = lang === 'ar';
  const builtins = {'@@bidi_dir':rtl?'rtl':'ltr', '@@ui_locale':lang,
    '@@bidi_reversed_dir':rtl?'ltr':'rtl', '@@bidi_start_edge':rtl?'right':'left',
    '@@bidi_end_edge':rtl?'left':'right', '@@extension_id':'poster-harness'};
  if (key in builtins) return builtins[key];
  const entry = catalog[key];
  if (!entry) return '';
  const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
  const positional = text => String(text).replace(/\$\$|\$([1-9]\d*)/g,
    (match, number) => number ? String(subs[Number(number)-1] ?? '') : '$');
  const placeholders = Object.fromEntries(Object.entries(entry.placeholders || {}).map(([k,v]) => [k.toLowerCase(),v]));
  // A single pass prevents dollar signs inside user substitutions from being expanded again.
  return entry.message.replace(/\$\$|\$([A-Za-z0-9_]+)\$|\$([1-9]\d*)/g, (match, name, number) => {
    if (name) return placeholders[name.toLowerCase()] ? positional(placeholders[name.toLowerCase()].content) : '';
    return number ? String(subs[Number(number)-1] ?? '') : '$';
  });
}
const tweetId = '1840000000000000000';
const current = {tweetId, screenName:'NASA'};
// No captured variants: the genuine popup displays its complete quality menu.
const record = {...current, type:'video', poster:'thumb.png', variants:[]};
const history = Array.from({length:4}, (_,i) => ({key:`demo-${i}`, tweetId,
  screenName:'NASA', tweetUrl:`https://x.com/NASA/status/${tweetId}`, quality:'720p',
  height:720, state:'complete', filename:`NASA_demo_${i+1}.mp4`, poster:'thumb.png'}));
const {DEFAULT_SETTINGS} = await import(new URL('src/lib/store.js', extension));
const data = {settings:{...DEFAULT_SETTINGS}, history};
const noop = () => {};
const event = {addListener:noop, removeListener:noop, hasListener:()=>false};
const result = (value, callback) => {if (callback) callback(value); return Promise.resolve(value);};
const storage = {
  get(keys, callback) {
    const selected = keys == null ? {...data} : Object.fromEntries(
      (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys))
        .map(key => [key, data[key] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys[key] : undefined)]));
    return result(selected, callback);
  },
  set(values, callback) {Object.assign(data,values); return result(undefined,callback);},
  remove:(_keys, callback)=>result(undefined,callback), clear:callback=>result(undefined,callback)
};
globalThis.chrome = {
  i18n:{getMessage, getUILanguage:()=>lang.replaceAll('_','-')},
  storage:{local:storage, sync:storage, onChanged:event},
  runtime:{id:'poster-harness', getURL:path=>new URL(path,extension).href, lastError:undefined,
    openOptionsPage:()=>Promise.resolve(), onMessage:event,
    sendMessage(message,callback) {
      const response = message.type === 'xvd:get-media' ? {ok:true,record} :
        message.type === 'xvd:download' ? {ok:true,label:'720p',filename:'NASA_demo.mp4'} : {ok:true};
      return result(response,callback);
    }},
  tabs:{query:(_query,callback)=>result([{id:1,active:true,url:'https://x.com/NASA/media'}],callback),
    sendMessage:(_id,message,callback)=>result(message.type === 'xvd:page-context' ? {current,record} : {ok:true,already:false},callback),
    create:()=>Promise.resolve(), onUpdated:event},
  downloads:{onChanged:event, show:noop, open:noop}, action:{setBadgeText:noop}
};
const source = new DOMParser().parseFromString(html,'text/html');
source.querySelectorAll('script').forEach(script=>script.remove());
source.querySelectorAll('[src],link[href]').forEach(el => {
  const attr = el.hasAttribute('src') ? 'src' : 'href';
  el.setAttribute(attr,new URL(el.getAttribute(attr),new URL('src/popup/popup.html',extension)).href);
});
document.head.replaceChildren(...Array.from(source.head.childNodes));
document.body.replaceChildren(...Array.from(source.body.childNodes));
document.documentElement.lang = lang.replaceAll('_','-');
document.documentElement.dir = getMessage('@@bidi_dir');
const stylesheetReady = Promise.all(Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(link =>
  link.sheet ? Promise.resolve() : new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject;})));
// Import the original ES module at its original URL, preserving relative imports.
await import(new URL('src/popup/popup.js',extension));
await new Promise(resolve => {
  const check = () => {
    if (!document.getElementById('detected').hidden && document.querySelectorAll('#recentList li').length === 4) {
      observer.disconnect(); resolve();
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body,{subtree:true,childList:true,attributes:true}); check();
});
await stylesheetReady;
await document.fonts.ready;
await Promise.all(Array.from(document.images).map(img => img.decode()));
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
document.body.dataset.ready = '1';
window.popupReady = true;
window.dispatchEvent(new Event('popup-ready'));

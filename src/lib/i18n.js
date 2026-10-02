// chrome.i18n wrapper for popup, options, and module content scripts.

export function isExtensionContextValid() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return false;
    chrome.runtime.getURL('');
    return true;
  } catch (_) {
    return false;
  }
}

export function t(key, ...subs) {
  if (!isExtensionContextValid()) return '';
  try {
    if (typeof chrome === 'undefined' || !chrome.i18n || !chrome.i18n.getMessage) {
      return key;
    }
    const msg = subs.length
      ? chrome.i18n.getMessage(key, subs.map((s) => String(s)))
      : chrome.i18n.getMessage(key);
    if (msg) return msg;
  } catch (_) {
    /* ignore */
  }
  if (!isExtensionContextValid()) return '';
  console.warn('[i18n] missing message:', key);
  return key;
}

export function localize(root = document) {
  const apply = (el) => {
    if (!el || el.nodeType !== 1) return;
    const textKey = el.getAttribute('data-i18n');
    if (textKey) el.textContent = t(textKey);
    const titleKey = el.getAttribute('data-i18n-title');
    if (titleKey) el.title = t(titleKey);
    const ariaKey = el.getAttribute('data-i18n-aria-label');
    if (ariaKey) el.setAttribute('aria-label', t(ariaKey));
    const phKey = el.getAttribute('data-i18n-placeholder');
    if (phKey) el.setAttribute('placeholder', t(phKey));
  };
  if (root.nodeType === 1) apply(root);
  if (!root.querySelectorAll) return;
  root
    .querySelectorAll(
      '[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]',
    )
    .forEach(apply);
}

export function uiLang() {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
      return chrome.i18n.getUILanguage() || 'en';
    }
  } catch (_) {
    /* ignore */
  }
  return 'en';
}

export function qualityLabel(value) {
  if (value === 'highest') return t('optionsQualityHighest');
  if (value === '1080') return t('optionsQuality1080');
  if (value === '720') return t('optionsQuality720');
  if (value === '480') return t('optionsQuality480');
  if (value === '360') return t('optionsQuality360');
  if (value === 'lowest') return t('optionsQualityLowest');
  return value;
}

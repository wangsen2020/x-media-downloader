// Pure product-site URL helpers. Only version, language, and install date.
export const SITE = 'https://xdown.goodexts.com';

export function siteLocalePrefix(uiLang) {
  const lang = String(uiLang || '').toLowerCase();
  if (lang.startsWith('zh')) return '/zh';
  if (lang.startsWith('pt')) return '/pt-br';
  if (lang.startsWith('es')) return '/es';
  return '';
}

export function welcomeUrl({ uiLang, version }) {
  const params = new URLSearchParams({
    utm_source: 'extension', utm_medium: 'install', v: version, hl: uiLang,
  });
  return `${SITE}${siteLocalePrefix(uiLang)}/welcome?${params}`;
}

export function uninstallUrl({ uiLang, version, installed }) {
  const params = new URLSearchParams({
    utm_source: 'extension', utm_medium: 'uninstall', ext: 'xmd', v: version, hl: uiLang,
  });
  if (installed) params.set('installed', installed);
  return `${SITE}${siteLocalePrefix(uiLang)}/uninstall?${params}`;
}

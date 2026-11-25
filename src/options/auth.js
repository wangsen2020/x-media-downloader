import {
  requestOptionalPermissions,
  ensureToken,
  isAuthCancelError,
} from '../lib/gdrive.js';
import { t, localize, uiLang } from '../lib/i18n.js';

document.documentElement.lang = uiLang();
document.documentElement.dir = t('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
localize();

const authView = document.getElementById('authView');
const successView = document.getElementById('successView');
const authBtn = document.getElementById('authBtn');
const cancelBtn = document.getElementById('cancelBtn');
const closeBtn = document.getElementById('closeBtn');
const viewUploadsBtn = document.getElementById('viewUploadsBtn');
const errEl = document.getElementById('err');

cancelBtn.addEventListener('click', () => window.close());
closeBtn.addEventListener('click', () => window.close());
viewUploadsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'xvd:open-uploads' }).catch(() => {});
  window.close();
});

authBtn.addEventListener('click', async () => {
  errEl.hidden = true;
  authBtn.disabled = true;
  try {
    const granted = await requestOptionalPermissions();
    if (!granted) {
      errEl.hidden = false;
      errEl.textContent = t('gdriveAuthCancelled');
      return;
    }
    await ensureToken({ interactive: true });
    await chrome.runtime.sendMessage({ type: 'xvd:gdrive-auth-done' });
    window.close();
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = isAuthCancelError(err)
      ? t('gdriveAuthCancelled')
      : String(err?.message || err);
  } finally {
    authBtn.disabled = false;
  }
});

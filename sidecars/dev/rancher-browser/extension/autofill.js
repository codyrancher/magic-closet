// Credentials come from config.js (rendered from the magic-closet env at
// container start). Keycloak pages get the keycloak list (its admin +
// realm users); everything else gets the Rancher local users.
function isKeycloakPage() {
  return location.hostname === 'keycloak' || !!document.getElementById('kc-form-login');
}
const CREDS = ((isKeycloakPage() ? MC_CONFIG.keycloakCreds : MC_CONFIG.creds) || [])
  .filter(c => c.password);

let bar = null;

function createBar() {
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = 'autofill-bar';

  const label = document.createElement('span');
  label.textContent = 'Quick Login:';
  bar.appendChild(label);

  const select = document.createElement('select');
  select.id = 'autofill-select';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select account…';
  select.appendChild(placeholder);

  CREDS.forEach((cred, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = cred.label + ' (' + cred.username + ')';
    select.appendChild(opt);
  });

  select.addEventListener('change', () => {
    if (select.value === '') return;
    const cred = CREDS[select.value];
    fillForm(cred.username, cred.password);
    bar.classList.remove('visible');
    select.value = '';
  });

  bar.appendChild(select);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => bar.classList.remove('visible'));
  bar.appendChild(closeBtn);

  document.body.appendChild(bar);
  return bar;
}

function fillForm(username, password) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const u = document.querySelector('input[name="username"], input[type="text"]');
  const p = document.querySelector('input[type="password"]');

  if (u) {
    setter.call(u, username);
    u.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (p) {
    setter.call(p, password);
    p.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function isLoginPage() {
  return location.pathname === '/auth/login' ||
    location.pathname.startsWith('/dashboard/auth/login') ||
    !!document.querySelector('form.login') ||
    !!document.getElementById('kc-form-login');
}

function attachListeners() {
  if (!isLoginPage() || !CREDS.length) return;
  const inputs = document.querySelectorAll(
    'input[name="username"], input[type="text"], input[type="password"]'
  );
  const show = () => {
    createBar();
    bar.classList.add('visible');
  };
  inputs.forEach(el => {
    if (el.dataset.autofillBound) return;
    el.dataset.autofillBound = '1';
    el.addEventListener('focus', show);
    // Keycloak autofocuses the username field before we bind — a click on an
    // already-focused element fires no focus event, so show the bar now
    if (document.activeElement === el) show();
  });
}

attachListeners();
new MutationObserver(attachListeners).observe(document.body, {
  childList: true,
  subtree: true,
});

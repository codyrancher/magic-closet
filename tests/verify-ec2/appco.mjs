// Verifies the AppCo OCI chart repo can be added to Rancher (mirrors the
// extension's create-appco-repo command) and reaches an active/downloaded state
// — which only happens if the AppCo credentials authenticate against the registry.
import { recorded, RANCHER, rancherToken, rget, rpost, authViaCookie, sleep } from './lib.mjs';

await recorded('appco', async (page, context) => {
  const email = process.env.APPCO_EMAIL, tok = process.env.APPCO_TOKEN;
  if (!email || !tok) throw new Error('APPCO_EMAIL / APPCO_TOKEN not set');
  const token = await rancherToken();
  const b64 = (s) => Buffer.from(s).toString('base64');

  let exists = false;
  try { await rget(`${RANCHER}/v1/catalog.cattle.io.clusterrepos/appco`, token); exists = true; } catch {}
  if (exists) {
    console.log('appco repo already exists — reusing');
  } else {
    try {
      await rpost(`${RANCHER}/v1/secrets`, token, {
        type: 'kubernetes.io/basic-auth',
        metadata: { name: 'appco-auth', namespace: 'cattle-system' },
        data: { username: b64(email), password: b64(tok) },
      });
    } catch (e) { console.log('secret:', e.message); }
    await rpost(`${RANCHER}/v1/catalog.cattle.io.clusterrepos`, token, {
      type: 'catalog.cattle.io.clusterrepo',
      metadata: { name: 'appco' },
      spec: { url: 'oci://dp.apps.rancher.io/charts', clientSecret: { name: 'appco-auth', namespace: 'cattle-system' } },
    });
    console.log('appco repo created');
  }

  let state = '';
  for (let i = 0; i < 50; i++) {
    const r = await rget(`${RANCHER}/v1/catalog.cattle.io.clusterrepos/appco`, token);
    state = r?.metadata?.state?.name
      || (r?.status?.conditions || []).map((c) => `${c.type}=${c.status}`).join(' ') || '';
    console.log('appco repo state:', state);
    if (/active|downloaded/i.test(state)) break;
    if (/error|fail/i.test(state)) break;
    await sleep(3000);
  }

  await authViaCookie(context, token);
  try {
    await page.goto(`${RANCHER}/dashboard/c/local/apps/catalog.cattle.io.clusterrepo`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('nav:', e.message); }
  await sleep(6000);
  await page.screenshot({ path: '/work/videos-out/appco.png', fullPage: true });

  if (!/active|downloaded/i.test(state)) throw new Error(`appco repo not active (last: ${state})`);
});

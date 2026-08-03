// Verifies the whole closet is running on the EC2 host: the dashboard loads and
// the api reports the core sidecars up. The dashboard's sidecar links carry the
// auto-detected public IP, which is visible in the recording.
import { recorded, DASH, API, sleep } from './lib.mjs';

await recorded('running-on-ec2', async (page) => {
  const { sidecars } = await (await fetch(`${API}/sidecars`)).json();
  const up = sidecars.filter((s) => s.status === 'running').map((s) => s.name);
  console.log('running sidecars:', up.join(', ') || '(none)');
  const need = ['rancher', 'rancher-browser', 'keycloak'];
  const missing = need.filter((n) => !up.includes(n));

  await page.goto(DASH, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(2500);
  await page.screenshot({ path: '/work/videos-out/running-on-ec2.png', fullPage: true });
  await sleep(1500);

  if (missing.length) throw new Error(`core sidecars not running: ${missing.join(', ')}`);
});

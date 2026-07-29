// Verifies the Figma sidecar starts on demand and reaches running.
import { recorded, DASH, API, sleep } from './lib.mjs';

await recorded('figma', async (page) => {
  await page.goto(DASH, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1500);

  console.log('starting figma...');
  const r = await fetch(`${API}/sidecars/figma/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  console.log('start ->', r.status);

  let status = '';
  for (let i = 0; i < 60; i++) {
    const { sidecars } = await (await fetch(`${API}/sidecars`)).json();
    status = (sidecars.find((s) => s.name === 'figma') || {}).status;
    console.log('figma status:', status);
    if (status === 'running') break;
    await sleep(3000);
  }

  try { await page.reload({ waitUntil: 'networkidle', timeout: 30000 }); } catch {}
  await sleep(2000);
  await page.screenshot({ path: '/work/videos-out/figma.png', fullPage: true });

  if (status !== 'running') throw new Error(`figma did not reach running (last: ${status})`);
});

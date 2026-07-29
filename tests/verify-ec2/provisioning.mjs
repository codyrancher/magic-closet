// Verifies real cluster provisioning: creates a single-node RKE2 EC2 cluster
// (mirrors the extension's create-ec2-cluster command, using the account's
// default VPC) and waits for it to go Active — which requires a downstream EC2
// node to launch and register against the closet's PUBLIC server-url. This is
// the check that can only pass when the closet runs on a publicly-reachable host.
import { recorded, RANCHER, rancherToken, rget, rpost, authViaCookie, sleep } from './lib.mjs';

const suffix = Math.random().toString(36).slice(2, 6);
const NAME = `mcverify-${suffix}`;
const NS = 'fleet-default';

await recorded('provisioning', async (page, context) => {
  const token = await rancherToken();

  const creds = await rget(`${RANCHER}/v3/cloudcredentials`, token);
  const cred = creds.data.find((c) => c.amazonec2credentialConfig || c.name === 'aws-credential');
  if (!cred) throw new Error('no AWS cloud credential');
  console.log('cloud credential:', cred.id);

  let k8s = (await rget(`${RANCHER}/v3/settings/rke2-default-version`, token)).value;
  if (k8s && k8s[0] !== 'v') k8s = `v${k8s}`;
  if (!k8s) throw new Error('rke2-default-version empty');
  console.log('k8s version:', k8s, '| cluster:', NAME);

  const mc = `${NAME}-machine`;
  await rpost(`${RANCHER}/v1/rke-machine-config.cattle.io.amazonec2configs`, token, {
    metadata: { namespace: NS, name: mc },
    region: 'us-west-2', zone: 'a', instanceType: 'c5d.xlarge', rootSize: '50',
    securityGroup: ['default', 'rancher-nodes'], securityGroupReadonly: false,
  });
  console.log('machine config created');

  await rpost(`${RANCHER}/v1/provisioning.cattle.io.clusters`, token, {
    type: 'provisioning.cattle.io.cluster',
    metadata: { namespace: NS, name: NAME },
    spec: {
      cloudCredentialSecretName: cred.id,
      kubernetesVersion: k8s,
      defaultPodSecurityAdmissionConfigurationTemplateName: '',
      rkeConfig: {
        chartValues: {},
        machineGlobalConfig: { cni: 'canal' },
        machinePools: [{
          name: 'pool1', controlPlaneRole: true, etcdRole: true, workerRole: true,
          quantity: 1, machineConfigRef: { kind: 'Amazonec2Config', name: mc },
        }],
      },
    },
  });
  console.log('cluster created:', NAME);

  await authViaCookie(context, token);
  try {
    await page.goto(`${RANCHER}/dashboard/c/local/manager/provisioning.cattle.io.cluster`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('nav:', e.message); }

  let state = '', ready = false;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    let c;
    try { c = await rget(`${RANCHER}/v1/provisioning.cattle.io.clusters/${NS}/${NAME}`, token); }
    catch (e) { console.log('poll:', e.message); await sleep(10000); continue; }
    state = c?.metadata?.state?.name || '';
    const conds = (c?.status?.conditions || [])
      .filter((x) => ['Ready', 'Provisioned', 'Updated', 'Created'].includes(x.type))
      .map((x) => `${x.type}=${x.status}`);
    console.log(new Date().toISOString(), 'cluster:', state, conds.join(' '));
    if (state === 'active') { ready = true; break; }
    if (state === 'error') console.log('  (error state — will keep watching in case it recovers)');
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    await sleep(20000);
  }

  await sleep(3000);
  await page.screenshot({ path: '/work/videos-out/provisioning.png', fullPage: true });
  console.log('FINAL cluster state:', state, '| active:', ready);
  if (!ready) throw new Error(`cluster did not reach active (last: ${state})`);
});

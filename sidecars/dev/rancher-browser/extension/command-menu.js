// Command registry — add new commands here
const COMMANDS = [
  {
    id: 'create-ec2-cluster',
    icon: '\u2601\uFE0F',
    label: 'Create EC2 Cluster',
    description: 'Single-node RKE2 cluster on EC2 (c5d.xlarge, us-west-2, Canal)',
    execute: createEc2Cluster,
  },
  {
    id: 'create-appco-repo',
    icon: '\ud83d\udce6',
    label: 'Create AppCo Chart Repository',
    description: 'Add OCI chart repository for oci://dp.apps.rancher.io/charts',
    execute: createAppCoRepo,
    show: function() { return window.location.pathname.includes('/explorer'); },
  },
];

// --- API helper ---

const API_BASE = window.location.origin;

function getCsrfToken() {
  var match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : 'CSRF';
}

async function rancherApi(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Api-Csrf': getCsrfToken(),
    },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(API_BASE + path, opts);
  if (!resp.ok) {
    let message;
    try {
      const json = await resp.json();
      message = json.message || json.error || resp.statusText;
    } catch {
      message = resp.statusText;
    }
    throw new Error(method + ' ' + path + ' failed (' + resp.status + '): ' + message);
  }
  return resp.json();
}

// --- EC2 cluster creation ---

async function createEc2Cluster(setStatus) {
  var suffix = Math.random().toString(36).substring(2, 6);
  var clusterName = 'cjackson-' + suffix;
  var ns = 'fleet-default';

  // 1. Find AWS cloud credential
  setStatus('pending', 'Finding AWS credential...');
  var credsResp = await rancherApi('GET', '/v3/cloudcredentials');
  var awsCred = credsResp.data.find(function (c) {
    return c.amazonec2credentialConfig || c.name === 'aws-credential';
  });
  if (!awsCred) throw new Error('No AWS cloud credential found. Create one in Cluster Management > Cloud Credentials first.');

  // 2. Create machine config
  setStatus('pending', 'Creating machine config...');
  var machineConfigName = clusterName + '-machine';
  await rancherApi('POST', '/v1/rke-machine-config.cattle.io.amazonec2configs', {
    metadata: {
      namespace: ns,
      name: machineConfigName,
    },
    region: 'us-west-2',
    zone: 'a',
    instanceType: 'c5d.xlarge',
    rootSize: '50',
    securityGroup: ['default', 'rancher-nodes'],
    securityGroupReadonly: true,
    subnetId: 'subnet-0c97a9f441ca3c895',
    vpcId: 'vpc-0c618e3a2ec9df47b',
  });

  // 3. Create RKE2 cluster with machine pool
  setStatus('pending', 'Creating cluster "' + clusterName + '"...');
  await rancherApi('POST', '/v1/provisioning.cattle.io.clusters', {
    type: 'provisioning.cattle.io.cluster',
    metadata: {
      namespace: ns,
      name: clusterName,
    },
    spec: {
      cloudCredentialSecretName: awsCred.id,
      kubernetesVersion: 'v1.34.4+rke2r1',
      defaultPodSecurityAdmissionConfigurationTemplateName: '',
      rkeConfig: {
        chartValues: {},
        machineGlobalConfig: {
          cni: 'canal',
        },
        machinePools: [
          {
            name: 'pool1',
            controlPlaneRole: true,
            etcdRole: true,
            workerRole: true,
            quantity: 1,
            machineConfigRef: {
              kind: 'Amazonec2Config',
              name: machineConfigName,
            },
          },
        ],
      },
    },
  });

  setStatus('success', 'Cluster "' + clusterName + '" creation initiated!');
}

// --- Cluster helpers ---

function getClusterFromUrl() {
  var match = window.location.pathname.match(/\/c\/([^/]+)\//);
  return match ? match[1] : 'local';
}

function clusterApiPrefix(clusterId) {
  return clusterId === 'local' ? '' : '/k8s/clusters/' + clusterId;
}

// --- AppCo chart repository creation ---

async function createAppCoRepo(setStatus) {
  var email = MC_CONFIG.appco.email;
  var token = MC_CONFIG.appco.token;

  if (!email || !token) {
    throw new Error('AppCo email and token not configured. Set APPCO_EMAIL and APPCO_TOKEN in .env.');
  }

  var clusterId = getClusterFromUrl();
  var apiPrefix = clusterApiPrefix(clusterId);
  var secretName = 'appco-auth';
  var repoName = 'appco';
  var secretNs = 'cattle-system';

  // 1. Create auth secret
  setStatus('pending', 'Creating AppCo auth secret...');
  await rancherApi('POST', apiPrefix + '/v1/secrets', {
    type: 'kubernetes.io/basic-auth',
    metadata: {
      name: secretName,
      namespace: secretNs,
    },
    data: {
      username: btoa(email),
      password: btoa(token),
    },
  });

  // 2. Create OCI chart repository
  setStatus('pending', 'Creating AppCo chart repository...');
  await rancherApi('POST', apiPrefix + '/v1/catalog.cattle.io.clusterrepos', {
    type: 'catalog.cattle.io.clusterrepo',
    metadata: {
      name: repoName,
    },
    spec: {
      url: 'oci://dp.apps.rancher.io/charts',
      clientSecret: {
        name: secretName,
        namespace: secretNs,
      },
    },
  });

  setStatus('success', 'AppCo chart repository created!');
}

// --- Menu UI ---

var menu = null;
var executing = false;

function createMenu() {
  if (menu) return menu;

  menu = document.createElement('div');
  menu.id = 'command-menu';

  // Header
  var header = document.createElement('div');
  header.className = 'cm-header';

  var title = document.createElement('span');
  title.className = 'cm-title';
  title.textContent = 'Commands';
  header.appendChild(title);

  var hint = document.createElement('span');
  hint.className = 'cm-hint';
  hint.textContent = 'Ctrl+M to toggle \u00b7 Esc to close';
  header.appendChild(hint);

  var closeBtn = document.createElement('button');
  closeBtn.className = 'cm-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', function () { hideMenu(); });
  header.appendChild(closeBtn);

  menu.appendChild(header);

  // Command items
  var items = document.createElement('div');
  items.className = 'cm-items';

  COMMANDS.forEach(function (cmd) {
    var item = document.createElement('div');
    item.className = 'cm-item';

    var icon = document.createElement('span');
    icon.className = 'cm-icon';
    icon.textContent = cmd.icon;
    item.appendChild(icon);

    var textCol = document.createElement('div');
    textCol.className = 'cm-text';

    var label = document.createElement('span');
    label.className = 'cm-label';
    label.textContent = cmd.label;
    textCol.appendChild(label);

    var desc = document.createElement('span');
    desc.className = 'cm-desc';
    desc.textContent = cmd.description;
    textCol.appendChild(desc);

    item.setAttribute('data-cmd-id', cmd.id);
    item.appendChild(textCol);
    item.addEventListener('click', function () { executeCommand(cmd); });
    items.appendChild(item);
  });

  menu.appendChild(items);

  // Status area
  var status = document.createElement('div');
  status.className = 'cm-status';
  status.id = 'cm-status';
  status.style.display = 'none';
  menu.appendChild(status);

  document.body.appendChild(menu);
  return menu;
}

function updateCommandVisibility() {
  if (!menu) return;
  COMMANDS.forEach(function (cmd) {
    var item = menu.querySelector('[data-cmd-id="' + cmd.id + '"]');
    if (!item) return;
    item.style.display = (cmd.show ? cmd.show() : true) ? '' : 'none';
  });
}

function showMenu() {
  createMenu();
  updateCommandVisibility();
  menu.classList.add('visible');
}

function hideMenu() {
  if (menu) menu.classList.remove('visible');
}

function toggleMenu() {
  createMenu();
  menu.classList.contains('visible') ? hideMenu() : showMenu();
}

async function executeCommand(cmd) {
  if (executing) return;
  executing = true;

  var statusEl = document.getElementById('cm-status');
  statusEl.style.display = 'block';
  statusEl.className = 'cm-status';

  function setStatus(state, message) {
    statusEl.textContent = message;
    statusEl.className = 'cm-status ' + state;
  }

  try {
    await cmd.execute(setStatus);
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
  } finally {
    executing = false;
  }
}

// --- Keyboard listener ---

document.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.key === 'm') {
    e.preventDefault();
    toggleMenu();
  }
  if (e.key === 'Escape' && menu && menu.classList.contains('visible')) {
    e.preventDefault();
    hideMenu();
  }
});

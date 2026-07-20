<script>
import { RcButton } from '@components/RcButton';
import { RcItemCard } from '@components/RcItemCard';
import { RcSection } from '@components/RcSection';
import RcIcon from '@components/RcIcon/RcIcon.vue';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import {
  closetApiBase, createCloset, createSharedSecret, listSharedSecrets,
  rancherFetch, readSharedSecret, setCluster,
} from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Create a closet, or edit an existing one's config: which sidecars run,
// their params, and the active Rancher auth provider. Saving applies the
// diff through the closet's api (start/stop/auth apply).
export default {
  name: 'ClosetEdit',

  components: {
    RcButton, RcIcon, RcItemCard, RcSection, ToggleSwitch, LabeledInput, LabeledSelect,
  },

  props: {
    value: {
      type:    Object,
      default: () => ({}),
    },
    mode: {
      type:    String,
      default: 'create',
    },
  },

  data() {
    return {
      name:      '',
      busy:      false,
      error:     null,
      // create mode
      createSidecars: {
        vscode:         true,
        rancher:        true,
        keycloak:       true,
        rancherBrowser: false,
        openldap:       false,
        figma:          false,
      },
      createGroups: [
        {
          name:  'Dev',
          items: [
            { key: 'vscode', label: 'VS Code' },
            { key: 'rancher', label: 'Rancher server (first start ~10 min)' },
            { key: 'rancherBrowser', label: 'Chromium browser' },
          ],
        },
        {
          name:  'Auth',
          items: [
            { key: 'keycloak', label: 'Keycloak (OIDC)' },
            { key: 'openldap', label: 'OpenLDAP' },
          ],
        },
        {
          name:  'Design',
          items: [{ key: 'figma', label: 'Figma MCP' }],
        },
      ],
      // edit mode
      sidecars:      [],
      enabled:       {},
      paramEdits:    {},
      authProvider:  '',
      loaded:        false,
      sharedSecrets: [],
      secretSel:     {},
      newSecrets:    {},
    };
  },

  computed: {
    isEdit() {
      return !!this.value?.spec?.namespace;
    },

    isView() {
      return this.mode === 'view';
    },

    apiBase() {
      return closetApiBase(this.value.spec.namespace);
    },

    groups() {
      const byGroup = {};

      for (const s of this.sidecars) {
        const g = s.group || 'dev';

        (byGroup[g] = byGroup[g] || []).push(s);
      }

      return Object.keys(byGroup)
        .sort((a, b) => {
          const ia = GROUP_ORDER.indexOf(a);
          const ib = GROUP_ORDER.indexOf(b);

          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
        .map((name) => ({ name, sidecars: byGroup[name] }));
    },

    authModes() {
      const modes = [{ value: '', label: 'None' }];

      for (const s of this.sidecars) {
        for (const m of s.rancherAuth?.modes || []) {
          modes.push({ value: m.value, label: `${ s.name }: ${ m.label }` });
        }
      }

      return modes;
    },
  },

  created() {
    setCluster(this.$route.params.cluster);
    if (this.isEdit) {
      this.load();
    }
  },

  methods: {
    async load() {
      try {
        const data = await rancherFetch(`${ this.apiBase }/sidecars`);

        this.sidecars = data.sidecars || [];
        this.authProvider = data.rancher?.authProvider || '';
        for (const s of this.sidecars) {
          this.enabled[s.name] = s.status === 'running';
          const edits = {};

          for (const p of s.params || []) {
            edits[p.id] = p.value ?? p.default ?? '';
          }
          this.paramEdits[s.name] = edits;
        }
        this.sharedSecrets = await listSharedSecrets();
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    // Token/secret-style params are backed by shared k8s Secrets (namespace
    // magic-closet-secrets) so they can be reused between closets
    isSecretParam(p) {
      return /(token|secret|key|password)$/i.test(p.id);
    },

    // Same pattern as the namespace picker: a highlighted "create new" entry
    // at the top of the dropdown that swaps to inline inputs
    secretOptions(s, p) {
      const current = this.paramEdits[s.name]?.[p.id];

      return [
        { label: 'Create a new secret…', value: '__create__', kind: 'highlighted' },
        { label: 'divider', disabled: true, kind: 'divider' },
        { label: current ? '(keep current value)' : '(none)', value: '' },
        ...this.sharedSecrets.map((n) => ({ label: n, value: n })),
      ];
    },

    onSecretSelect(key, val) {
      const v = typeof val === 'object' ? val?.value : val;

      this.secretSel[key] = v;
      if (v === '__create__' && !this.newSecrets[key]) {
        this.newSecrets[key] = { value: '' };
      }
    },

    // Secret names are derived from the param (ghToken -> gh-token),
    // deduped with a numeric suffix — the user only supplies the value
    secretNameFor(paramId) {
      const base = paramId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      let name = base;
      let i = 2;

      while (this.sharedSecrets.includes(name)) {
        name = `${ base }-${ i++ }`;
      }

      return name;
    },

    cancelCreateSecret(key) {
      this.secretSel[key] = '';
      delete this.newSecrets[key];
    },

    cardFor(s) {
      return { id: `sidecar-${ s.name }`, header: {} };
    },

    startBody(s) {
      const params = { ...(this.paramEdits[s.name] || {}) };

      for (const p of s.params || []) {
        if (p.type === 'boolean') {
          params[p.id] = params[p.id] && params[p.id] !== 'false' ? 'true' : '';
        }
      }

      return { params };
    },

    paramsChanged(s) {
      return (s.params || []).some((p) => (this.paramEdits[s.name]?.[p.id] ?? '') !== (p.value ?? p.default ?? ''));
    },

    async save() {
      this.busy = true;
      this.error = null;
      const failures = [];

      // Resolve selected shared secrets into param values first — creating
      // any new ones typed inline
      for (const [key, secretName] of Object.entries(this.secretSel)) {
        if (!secretName) {
          continue;
        }
        const [sidecar, paramId] = key.split('::');

        try {
          if (secretName === '__create__') {
            const ns = this.newSecrets[key] || {};

            if (!ns.value) {
              failures.push(`${ sidecar }/${ paramId }: new secret needs a value`);
              continue;
            }
            const name = this.secretNameFor(paramId);

            await createSharedSecret(name, ns.value);
            this.sharedSecrets = [...this.sharedSecrets, name].sort();
            this.paramEdits[sidecar][paramId] = ns.value;
          } else {
            this.paramEdits[sidecar][paramId] = await readSharedSecret(secretName);
          }
        } catch (e) {
          failures.push(`secret ${ secretName }: ${ e.message }`);
        }
      }

      for (const s of this.sidecars) {
        if (s.unsupported && s.status === 'not_created') {
          continue;
        }
        const wasRunning = s.status === 'running';
        const want = !!this.enabled[s.name];

        try {
          if (want && (!wasRunning || this.paramsChanged(s))) {
            await rancherFetch(`${ this.apiBase }/sidecars/${ s.name }/start`, {
              method: 'POST',
              body:   JSON.stringify(this.startBody(s)),
            });
          } else if (!want && wasRunning) {
            await rancherFetch(`${ this.apiBase }/sidecars/${ s.name }/stop`, { method: 'POST' });
          }
        } catch (e) {
          failures.push(`${ s.name }: ${ e.message }`);
        }
      }

      const currentAuth = (await rancherFetch(`${ this.apiBase }/sidecars`).catch(() => null))?.rancher?.authProvider || '';

      if (this.authProvider && this.authProvider !== currentAuth) {
        try {
          await rancherFetch(`${ this.apiBase }/auth/apply`, {
            method: 'POST',
            body:   JSON.stringify({ provider: this.authProvider }),
          });
        } catch (e) {
          failures.push(`auth: ${ e.message }`);
        }
      }

      if (failures.length) {
        this.error = failures.join(' — ');
        this.busy = false;

        return;
      }
      this.done(true);
    },

    async create() {
      this.busy = true;
      this.error = null;
      try {
        await createCloset(this.name, this.createSidecars);
        this.refreshUntilListed(this.name);
        this.done();
      } catch (e) {
        this.error = e.message;
        this.busy = false;
      }
    },

    // The helm app record can lag a few seconds behind the install call, and
    // the spoofed type is served from cache — force-refetch until the new
    // closet shows up so the list updates without a page reload
    async refreshUntilListed(name) {
      const store = this.$store;

      for (let i = 0; i < 15; i++) {
        const all = await store.dispatch('cluster/findAll', { type: CLOSET_TYPE, opt: { force: true } });

        if ((all || []).some((c) => c.metadata?.name === name)) {
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },

    done(toDetail = false) {
      if (toDetail && this.isEdit) {
        this.$router.push({
          name:   'c-cluster-product-resource-id',
          params: {
            cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE, id: this.value.metadata.name,
          },
        });

        return;
      }
      this.$router.push({
        name:   'c-cluster-product-resource',
        params: { cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE },
      });
    },
  },
};
</script>

<template>
  <!-- Edit config for an existing closet -->
  <div v-if="isEdit" class="closet-create">
    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <div v-if="!loaded" class="hint">
      Loading current configuration…
    </div>

    <template v-else>
      <RcSection
        v-for="group in groups"
        :key="group.name"
        :title="group.name.charAt(0).toUpperCase() + group.name.slice(1)"
        type="primary"
        mode="with-header"
        class="edit-group"
      >
        <div class="cards">
          <rc-item-card
            v-for="s in group.sidecars"
            :id="`sidecar-${s.name}`"
            :key="s.name"
            v-bind="cardFor(s)"
            variant="medium"
          >
            <template #item-card-header-title>
              <div class="title-row">
                <h3 class="item-card-header-title medium">
                  {{ s.name }}
                </h3>
                <ToggleSwitch
                  class="enable-toggle"
                  :value="!!enabled[s.name]"
                  :disabled="isView || (!!s.unsupported && s.status === 'not_created')"
                  @update:value="enabled[s.name] = $event"
                />
              </div>
            </template>

            <template #item-card-sub-header>
              <div class="sub">
                <div class="desc">
                  {{ s.description }}
                </div>
                <span v-if="s.unsupported" class="unsupported">{{ s.unsupported }}</span>
              </div>
            </template>

            <template #item-card-footer>
              <div v-if="enabled[s.name] && (s.params || []).length" class="params">
                <template v-for="p in s.params" :key="p.id">
                  <div v-if="p.type === 'boolean'" class="param-row">
                    <label :for="`${s.name}-${p.id}`">{{ p.id }}</label>
                    <ToggleSwitch
                      :id="`${s.name}-${p.id}`"
                      :value="!!paramEdits[s.name][p.id] && paramEdits[s.name][p.id] !== 'false'"
                      :disabled="isView"
                      @update:value="paramEdits[s.name][p.id] = $event ? 'true' : ''"
                    />
                  </div>
                  <div
                    v-else-if="isSecretParam(p) && secretSel[`${s.name}::${p.id}`] === '__create__'"
                    class="secret-create"
                  >
                    <LabeledInput
                      v-model:value="newSecrets[`${s.name}::${p.id}`].value"
                      type="password"
                      :label="`${p.id}: new secret value`"
                    />
                    <rc-button
                      variant="ghost"
                      size="small"
                      aria-label="Cancel"
                      @click="cancelCreateSecret(`${s.name}::${p.id}`)"
                    >
                      <rc-icon type="close" size="small" />
                    </rc-button>
                  </div>
                  <LabeledSelect
                    v-else-if="isSecretParam(p)"
                    class="secret-select"
                    :mode="mode"
                    :label="p.id"
                    :value="secretSel[`${s.name}::${p.id}`] || ''"
                    :options="secretOptions(s, p)"
                    :searchable="false"
                    @update:value="onSecretSelect(`${s.name}::${p.id}`, $event)"
                  />
                  <LabeledInput
                    v-else
                    v-model:value="paramEdits[s.name][p.id]"
                    :mode="mode"
                    :label="p.id"
                    :placeholder="p.default || ''"
                  />
                </template>
              </div>
            </template>
          </rc-item-card>
        </div>
      </RcSection>

      <RcSection
        title="Rancher auth"
        type="primary"
        mode="with-header"
        class="edit-group"
      >
        <LabeledSelect
          id="auth-provider"
          class="auth-select"
          :mode="mode"
          label="provider"
          :value="authProvider"
          :options="authModes"
          :searchable="false"
          @update:value="authProvider = typeof $event === 'object' ? ($event && $event.value) : $event"
        />
      </RcSection>

      <div v-if="!isView" class="actions">
        <rc-button variant="secondary" @click="done(true)">
          Cancel
        </rc-button>
        <rc-button variant="primary" :disabled="busy" @click="save">
          {{ busy ? 'Saving…' : 'Save' }}
        </rc-button>
      </div>
    </template>
  </div>

  <!-- Create a new closet -->
  <div v-else class="closet-create create">
    <p class="hint">
      Installs a closet into this cluster (namespace <code>closet-&lt;name&gt;</code>):
      a project workspace plus the sidecars you pick, managed by the closet's
      own dashboard.
    </p>

    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <div class="form">
      <label>Name</label>
      <input v-model="name" placeholder="e.g. pr-18387" @keyup.enter="create">
    </div>

    <RcSection
      v-for="g in createGroups"
      :key="g.name"
      :title="g.name"
      type="primary"
      mode="with-header"
      class="edit-group"
    >
      <div class="toggle-rows">
        <div v-for="item in g.items" :key="item.key" class="toggle-row">
          <span>{{ item.label }}</span>
          <ToggleSwitch
            :value="!!createSidecars[item.key]"
            @update:value="createSidecars[item.key] = $event"
          />
        </div>
      </div>
    </RcSection>

    <div class="actions">
      <rc-button variant="secondary" @click="done()">
        Cancel
      </rc-button>
      <rc-button variant="primary" :disabled="!name || busy" @click="create">
        {{ busy ? 'Creating…' : 'Create' }}
      </rc-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.closet-create {
  padding: 20px 0 40px 0;

  &.create {
    max-width: 640px;
    padding: 20px;
  }

  .hint {
    opacity: 0.8;
    margin: 10px 0 20px;
  }

  .banner.error {
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 15px;
  }

  .edit-group {
    margin-top: 12px;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;

    h3 {
      margin: 0;
    }

    .enable-toggle {
      margin-left: auto;
    }
  }

  .sub {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .desc {
      color: var(--body-text);
    }
  }

  .params {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  .unsupported {
    font-style: italic;
    color: var(--muted);
    font-size: 12px;
  }

  .auth-select {
    max-width: 360px;
  }

  .sidecar-row {
    margin-bottom: 12px;

    .check.head {
      display: flex;
      gap: 8px;
      align-items: baseline;

      .sidecar-name {
        font-weight: 600;
      }
    }

    .unsupported {
      font-style: italic;
      color: var(--muted);
      font-size: 12px;
    }

    .params {
      margin: 6px 0 0 24px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 440px;
    }
  }

  .secret-create {
    display: flex;
    gap: 6px;
    align-items: center;
    width: 100%;
    min-width: 0;

    .labeled-input {
      flex: 1;
      min-width: 0;
    }
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: 8px;

    label {
      width: 40%;
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .secret-select {
      flex: 1;
      min-width: 0;
    }

    input[type='text'], input[type='password'], select {
      flex: 1;
      min-width: 0;
      background: var(--input-bg);
      color: var(--input-text);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 13px;
    }
  }

  .toggle-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 440px;

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 20px;

    > label {
      opacity: 0.8;
      font-size: 13px;
    }

    .checks {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;

      .check {
        display: flex;
        gap: 8px;
        align-items: center;
      }
    }
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 20px;
  }
}
</style>

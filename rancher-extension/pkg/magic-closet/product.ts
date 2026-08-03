import { IPlugin } from '@shell/core/types';
import { STATE, NAME } from '@shell/config/table-headers';
import { closetApiBase, listClosets, listSecretSets, setCluster, setSecretOwner } from './api';
// Generated from the sidecar.yml credential declarations — the same source the
// edit form renders from, so the "N/total" Keys column can't drift out of sync.
import { CREDENTIAL_KEYS } from './credentials.generated';

// Everything is registered on the cluster explorer product: closets appear as
// a single flat nav entry (like the dashboard links) instead of a product
// group, and the list/detail/create pages use the explorer's generic routes.
export const EXPLORER = 'explorer';
export const CLOSET_TYPE = 'magic-closet.closet';
export const SECRET_SET_TYPE = 'magic-closet.secret-set';

// User preference (per-user, default off) that gates whether the Magic Closet
// nav shows in the explorer. The checkbox is rendered by the overridden prefs
// page (pages/prefs.vue), appended to the Advanced Features section.
export const NAV_PREF = 'magic-closet-nav';

export function init($plugin: IPlugin, store: any) {
  // spoofedType exists at runtime but is missing from DSLReturnType
  const dsl: any = $plugin.DSL(store, EXPLORER);
  const {
    basicType, configureType, headers, spoofedType, virtualType, weightGroup,
  } = dsl;

  // Register the nav toggle preference (default off) if it isn't already, then
  // read it. Product init runs once at load, so toggling the checkbox takes
  // effect on the next page load — enough for a show/hide-the-nav preference.
  let navEnabled = false;

  try {
    store.commit('prefs/setDefinition', {
      name:       NAV_PREF,
      definition: { default: false, parseJSON: true, asUserPreference: true },
    });
    navEnabled = !!store.getters['prefs/get'](NAV_PREF);
  } catch { /* prefs store shape changed — fail open below */ }

  spoofedType({
    label:             'Magic Closets',
    type:              CLOSET_TYPE,
    product:           EXPLORER,
    collectionMethods: ['POST'],
    schemas:           [{
      id:                CLOSET_TYPE,
      type:              'schema',
      collectionMethods: ['POST'],
      resourceMethods:   ['DELETE'],
      resourceFields:    { spec: { type: 'json' } },
    }],
    getInstances: async () => {
      setCluster(store.getters['clusterId']);
      const closets = await listClosets();

      return Promise.all(closets.map(async (c: any) => {
        let sidecars = null;

        // Skip the api probe for a closet that's still being created \u2014 its
        // service doesn't exist yet, and the row shows a "Creating" state.
        if (c.state !== 'creating') {
          try {
            const resp = await fetch(`${ closetApiBase(c.namespace) }/sidecars`);
            const data = await resp.json();
            const list = data.sidecars || [];

            sidecars = `${ list.filter((s: any) => s.status === 'running').length }/${ list.length } running`;
          } catch { /* closet api not reachable (yet) */ }
        }

        const active = c.state === 'deployed';

        return {
          id:       c.name,
          type:     CLOSET_TYPE,
          spec:     c,
          sidecars: c.state === 'creating' ? 'Creating\u2026' : (sidecars || '\u2014'),
          metadata: {
            name:  c.name,
            state: {
              name:          active ? 'active' : c.state,
              error:         false,
              transitioning: !active,
            },
          },
        };
      }));
    },
  });

  configureType(CLOSET_TYPE, {
    isCreatable: true,
    // No separate "Edit Config" — the detail page is interactive (start/stop +
    // per-sidecar config live there).
    isEditable:  false,
    isRemovable: true,
    showAge:     false,
    showState:   true,
    canYaml:     false,
  });

  headers(CLOSET_TYPE, [
    STATE,
    NAME,
    { name: 'sidecars', label: 'Sidecars', value: 'sidecars', sort: ['sidecars'] },
    { name: 'namespace', label: 'Namespace', value: 'spec.namespace', sort: ['spec.namespace'] },
  ]);

  setSecretOwner(store.getters['auth/principalId']);

  // Secret Sets — a per-user resource (bundles of tokens/keys reused across
  // closets). Standard list/create/edit pages.
  spoofedType({
    label:             'Secret Sets',
    type:              SECRET_SET_TYPE,
    product:           EXPLORER,
    collectionMethods: ['POST'],
    schemas:           [{
      id:                SECRET_SET_TYPE,
      type:              'schema',
      collectionMethods: ['POST'],
      resourceMethods:   ['PUT', 'DELETE'],
      resourceFields:    { spec: { type: 'json' } },
    }],
    getInstances: async () => {
      setSecretOwner(store.getters['auth/principalId']);
      const sets = await listSecretSets();

      return sets.map((set: any) => ({
        id:       set.name,
        type:     SECRET_SET_TYPE,
        isDefault: set.isDefault,
        keyList:  `${ (set.keys || []).length }/${ CREDENTIAL_KEYS.length }`,
        spec:     set,
        metadata: { name: set.name },
      }));
    },
  });

  configureType(SECRET_SET_TYPE, {
    isCreatable: true,
    isEditable:  true,
    isRemovable: true,
    showAge:     false,
    showState:   false,
    canYaml:     false,
  });

  headers(SECRET_SET_TYPE, [
    NAME,
    { name: 'default', label: 'Default', value: 'isDefault', sort: ['isDefault'], formatter: 'Checked' },
    { name: 'keys', label: 'Keys', value: 'keyList', sort: ['keyList'] },
  ]);

  // The nav entries (the only user-visible registration) are gated on the
  // preference; the spoofed types/routes above stay registered so a direct link
  // still resolves. Both resources live under a "Magic Closet" nav group.
  if (navEnabled) {
    virtualType({
      label:      'Closets',
      namespaced: false,
      name:       'magic-closet',
      weight:     10,
      route:      {
        name:   'c-cluster-product-resource',
        params: { product: EXPLORER, resource: CLOSET_TYPE },
      },
    });
    virtualType({
      label:      'Secret Sets',
      namespaced: false,
      name:       'magic-closet-secrets',
      weight:     9,
      route:      {
        name:   'c-cluster-product-resource',
        params: { product: EXPLORER, resource: SECRET_SET_TYPE },
      },
    });
    weightGroup('magicCloset', -100, true);
    basicType(['magic-closet', 'magic-closet-secrets'], 'magicCloset');
  }
}

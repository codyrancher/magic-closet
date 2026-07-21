import { IPlugin } from '@shell/core/types';
import { STATE, NAME } from '@shell/config/table-headers';
import { closetApiBase, listClosets, listSecretSets, setCluster, setSecretOwner } from './api';

// Everything is registered on the cluster explorer product: closets appear as
// a single flat nav entry (like the dashboard links) instead of a product
// group, and the list/detail/create pages use the explorer's generic routes.
export const EXPLORER = 'explorer';
export const CLOSET_TYPE = 'magic-closet.closet';
export const SECRET_SET_TYPE = 'magic-closet.secret-set';

export function init($plugin: IPlugin, store: any) {
  // spoofedType exists at runtime but is missing from DSLReturnType
  const dsl: any = $plugin.DSL(store, EXPLORER);
  const {
    basicType, configureType, headers, spoofedType, virtualType,
  } = dsl;

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

        try {
          const resp = await fetch(`${ closetApiBase(c.namespace) }/sidecars`);
          const data = await resp.json();
          const list = data.sidecars || [];

          sidecars = `${ list.filter((s: any) => s.status === 'running').length }/${ list.length } running`;
        } catch { /* closet api not reachable (yet) */ }

        return {
          id:       c.name,
          type:     CLOSET_TYPE,
          spec:     c,
          sidecars: sidecars || '\u2014',
          metadata: {
            name:  c.name,
            state: {
              name:          c.state === 'deployed' ? 'active' : c.state,
              error:         false,
              transitioning: c.state !== 'deployed',
            },
          },
        };
      }));
    },
  });

  configureType(CLOSET_TYPE, {
    isCreatable: true,
    isEditable:  true,
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
        keyList:  (set.keys || []).join(', ') || '—',
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

  // Two flat nav entries at the bottom of the cluster explorer nav
  virtualType({
    label:      'Magic Closet',
    group:      'Root',
    namespaced: false,
    name:       'magic-closet',
    weight:     -100,
    route:      {
      name:   'c-cluster-product-resource',
      params: { product: EXPLORER, resource: CLOSET_TYPE },
    },
  });
  virtualType({
    label:      'Secret Sets',
    group:      'Root',
    namespaced: false,
    name:       'magic-closet-secrets',
    weight:     -101,
    route:      {
      name:   'c-cluster-product-resource',
      params: { product: EXPLORER, resource: SECRET_SET_TYPE },
    },
  });
  basicType(['magic-closet', 'magic-closet-secrets']);
}

import { IPlugin } from '@shell/core/types';
import { STATE, NAME } from '@shell/config/table-headers';
import { closetApiBase, listClosets, setCluster, setSecretOwner } from './api';

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

  // A hidden spoofed type used only to host the Configure Secrets page (its
  // list component is list/magic-closet.secret-set.vue); not shown in the nav.
  spoofedType({
    label:             'Secret Sets',
    type:              SECRET_SET_TYPE,
    product:           EXPLORER,
    collectionMethods: [],
    schemas:           [{
      id:                SECRET_SET_TYPE,
      type:              'schema',
      collectionMethods: [],
      resourceMethods:   [],
      resourceFields:    {},
    }],
    getInstances: async () => [],
  });

  configureType(SECRET_SET_TYPE, {
    isCreatable: false, isEditable: false, isRemovable: false, showAge: false, showState: false, canYaml: false,
  });

  // Single flat entry at the bottom of the cluster explorer nav
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
  basicType(['magic-closet']);
}

import { IPlugin } from '@shell/core/types';
import { STATE, NAME } from '@shell/config/table-headers';
import { closetApiBase, listClosets, setCluster } from './api';

export const PRODUCT_NAME = 'magicCloset';
export const CLOSET_TYPE = 'magic-closet.closet';

export function init($plugin: IPlugin, store: any) {
  const explorer: any = $plugin.DSL(store, 'explorer');

  explorer.virtualType({
    label:      'Magic Closet',
    group:      'Root',
    namespaced: false,
    name:       'magic-closet',
    weight:     -100,
    route:      {
      name:   `c-cluster-${ PRODUCT_NAME }-resource`,
      params: { product: PRODUCT_NAME, resource: CLOSET_TYPE },
    },
  });
  explorer.basicType(['magic-closet']);

  // spoofedType exists at runtime but is missing from DSLReturnType
  const dsl: any = $plugin.DSL(store, PRODUCT_NAME);
  const {
    product, basicType, configureType, headers, spoofedType,
  } = dsl;

  product({
    icon:    'gear',
    inStore: 'cluster',
    to:      {
      name:   `c-cluster-${ PRODUCT_NAME }-resource`,
      params: { product: PRODUCT_NAME, resource: CLOSET_TYPE },
    },
  });

  spoofedType({
    label:             'Closets',
    type:              CLOSET_TYPE,
    product:           PRODUCT_NAME,
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
        let authProvider = null;

        try {
          const resp = await fetch(`${ closetApiBase(c.namespace) }/sidecars`);
          const data = await resp.json();
          const list = data.sidecars || [];

          sidecars = `${ list.filter((s: any) => s.status === 'running').length }/${ list.length } running`;
          authProvider = data.rancher?.authProvider || null;
        } catch { /* closet api not reachable (yet) */ }

        return {
          id:       c.name,
          type:     CLOSET_TYPE,
          spec:     c,
          sidecars: sidecars || '—',
          auth:     authProvider || '—',
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
    isEditable:  false,
    isRemovable: true,
    showAge:     false,
    showState:   true,
    canYaml:     false,
    customRoute: {
      name:   `c-cluster-${ PRODUCT_NAME }-resource`,
      params: { product: PRODUCT_NAME, resource: CLOSET_TYPE },
    },
  });

  headers(CLOSET_TYPE, [
    STATE,
    NAME,
    { name: 'sidecars', label: 'Sidecars', value: 'sidecars', sort: ['sidecars'] },
    { name: 'auth', label: 'Auth', value: 'auth', sort: ['auth'] },
    { name: 'namespace', label: 'Namespace', value: 'spec.namespace', sort: ['spec.namespace'] },
  ]);

  // No basicType here: the product itself stays out of the nav (an empty
  // group isn't rendered). Instead a single flat entry - like the dashboard
  // links - is registered on the explorer product above, sorted last.
}

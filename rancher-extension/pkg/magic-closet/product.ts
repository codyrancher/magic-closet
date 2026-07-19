import { IPlugin } from '@shell/core/types';

export const PRODUCT_NAME = 'magicCloset';

export function init($plugin: IPlugin, store: any) {
  const { product, virtualType, basicType } = $plugin.DSL(store, PRODUCT_NAME);

  product({
    icon:    'gear',
    inStore: 'cluster',
    weight:  100,
    to:      {
      name:   `c-cluster-${ PRODUCT_NAME }`,
      params: { product: PRODUCT_NAME },
    },
  });

  virtualType({
    label:  'Closets',
    name:   'closets',
    route:  {
      name:   `c-cluster-${ PRODUCT_NAME }`,
      params: { product: PRODUCT_NAME },
    },
  });

  basicType(['closets']);
}

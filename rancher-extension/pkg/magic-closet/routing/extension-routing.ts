import ConfigureSecrets from '../pages/configure-secrets.vue';

const routes = [
  {
    name:      'c-cluster-magic-closet-secrets',
    path:      '/c/:cluster/magic-closet/secrets',
    component: ConfigureSecrets,
    meta:      { product: 'explorer', pkg: 'magic-closet' },
  },
];

export default routes;

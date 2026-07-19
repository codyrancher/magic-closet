import ListResource from '@shell/pages/c/_cluster/_product/_resource/index.vue';
import CreateResource from '@shell/pages/c/_cluster/_product/_resource/create.vue';
import ViewResource from '@shell/pages/c/_cluster/_product/_resource/_id.vue';
import { PRODUCT_NAME } from '../product';

const meta = { product: PRODUCT_NAME, pkg: PRODUCT_NAME };

const routes = [
  {
    name:      `c-cluster-${ PRODUCT_NAME }-resource`,
    path:      `/c/:cluster/${ PRODUCT_NAME }/:resource`,
    component: ListResource,
    meta,
  },
  {
    name:      `c-cluster-${ PRODUCT_NAME }-resource-create`,
    path:      `/c/:cluster/${ PRODUCT_NAME }/:resource/create`,
    component: CreateResource,
    meta,
  },
  {
    name:      `c-cluster-${ PRODUCT_NAME }-resource-id`,
    path:      `/c/:cluster/${ PRODUCT_NAME }/:resource/:id`,
    component: ViewResource,
    meta,
  },
];

export default routes;

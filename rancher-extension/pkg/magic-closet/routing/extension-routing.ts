import ClosetList from '../pages/ClosetList.vue';
import ClosetDetail from '../pages/ClosetDetail.vue';
import { PRODUCT_NAME } from '../product';

const routes = [
  {
    name:      `c-cluster-${ PRODUCT_NAME }`,
    path:      `/c/:cluster/${ PRODUCT_NAME }`,
    component: ClosetList,
    meta:      { product: PRODUCT_NAME, pkg: PRODUCT_NAME },
  },
  {
    name:      `c-cluster-${ PRODUCT_NAME }-closet`,
    path:      `/c/:cluster/${ PRODUCT_NAME }/closet/:closet`,
    component: ClosetDetail,
    meta:      { product: PRODUCT_NAME, pkg: PRODUCT_NAME },
  },
];

export default routes;

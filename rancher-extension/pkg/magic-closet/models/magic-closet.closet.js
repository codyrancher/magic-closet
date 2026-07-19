import Resource from '@shell/plugins/dashboard-store/resource-class';
import { deleteCloset } from '../api';

export default class Closet extends Resource {
  get canDelete() {
    return true;
  }

  get canClone() {
    return false;
  }

  get canYaml() {
    return false;
  }

  get canViewInApi() {
    return false;
  }

  async remove() {
    await deleteCloset(this.spec);
    await this.$dispatch('findAll', { type: this.type, opt: { force: true } });
  }
}

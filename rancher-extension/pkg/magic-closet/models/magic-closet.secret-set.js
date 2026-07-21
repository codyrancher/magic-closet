import Resource from '@shell/plugins/dashboard-store/resource-class';
import { deleteSecretSet } from '../api';

export default class SecretSet extends Resource {
  get canDelete() {
    return true;
  }

  get canUpdate() {
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
    await deleteSecretSet(this.metadata.name);
    await this.$dispatch('findAll', { type: this.type, opt: { force: true } });
  }
}

import Resource from '@shell/plugins/dashboard-store/resource-class';
import { deleteSecretSet, setSecretSetDefault } from '../api';

export default class SecretSet extends Resource {
  get canDelete() {
    return true;
  }

  get canUpdate() {
    return true;
  }

  // Add "Make default" to the row/detail action menu (only when not already
  // the default). Standard actions (Edit Config, Delete) come from super.
  get _availableActions() {
    const out = super._availableActions;

    if (!this.isDefault) {
      out.unshift({
        action: 'makeDefault',
        label:  'Make default',
        icon:   'icon icon-checkmark',
      });
    }

    return out;
  }

  async makeDefault() {
    await setSecretSetDefault(this.metadata.name);
    await this.$dispatch('findAll', { type: this.type, opt: { force: true } });
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

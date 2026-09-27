import { whisperModel } from '../providers/whisper-models.js';

export class LocalSpeechToTextService {
  constructor({ configStore, modelManager } = {}) {
    if (!configStore?.load || !configStore?.setModel || !modelManager?.status || !modelManager?.install || !modelManager?.list) {
      throw new TypeError('Speech-to-text configuration and model management services are required.');
    }
    this.configStore = configStore;
    this.modelManager = modelManager;
  }

  async getState() {
    const [config, models] = await Promise.all([this.configStore.load(), this.modelManager.list()]);
    return {
      selected_model: config.model,
      default_model: this.configStore.defaultModel,
      config_recovered: config.recovered,
      warning: config.warning,
      models: models.map((model) => {
        const { path, sha256, ...publicModel } = model;
        return { ...publicModel, selected: model.id === config.model };
      }),
    };
  }

  async resolveModel() {
    return (await this.configStore.load()).model;
  }

  async selectModel(modelId) {
    const id = whisperModel(modelId).id;
    const state = await this.modelManager.status(id);
    if (!state.ready) {
      throw Object.assign(new Error(`${state.display_name || id} is not installed and verified.`), {
        code: 'STT_MODEL_NOT_INSTALLED', status: 409, model_state: state.state,
      });
    }
    await this.configStore.setModel(id);
    return this.getState();
  }

  async installModel(modelId) {
    const id = whisperModel(modelId).id;
    await this.modelManager.install(id);
    return this.getState();
  }
}

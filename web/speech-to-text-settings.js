const STATE_LABELS = Object.freeze({
  installed: 'Installed',
  not_installed: 'Not installed',
  installing: 'Installing…',
  unavailable: 'Unavailable',
  error: 'Unavailable',
});

export function modelOptionLabel(model) {
  return `${model.display_name} — ${STATE_LABELS[model.state] || 'Unavailable'}`;
}

export function modelSelectionView(state, modelId) {
  const model = state.models.find((entry) => entry.id === modelId) || state.models.find((entry) => entry.id === state.selected_model);
  if (!model) return { model: null, message: 'Model information is unavailable.', action: 'wait', actionLabel: null };
  if (model.state === 'installing') {
    return { model, message: `${model.display_name} is installing…`, action: 'wait', actionLabel: null };
  }
  if (model.ready) {
    return {
      model,
      message: `${model.description} ${model.id === state.selected_model ? 'Installed and active.' : 'Installed and ready to select.'}`,
      action: model.id === state.selected_model ? 'none' : 'select',
      actionLabel: model.id === state.selected_model ? null : `Use ${model.display_name}`,
    };
  }
  if (model.state === 'not_installed') {
    return { model, message: `${model.description} Install it before selecting it.`, action: 'install', actionLabel: `Install ${model.display_name}` };
  }
  return {
    model,
    message: `${model.display_name} is unavailable${model.error_code ? ` (${model.error_code})` : ''}. Reinstall it to recover.`,
    action: 'install',
    actionLabel: `Reinstall ${model.display_name}`,
  };
}

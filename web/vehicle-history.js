const byId = (id) => document.getElementById(id);
let token = sessionStorage.getItem('field-report.session') || '';

async function sessionToken() {
  if (token) return token;
  const response = await fetch('/session-bootstrap', { method: 'POST' });
  const body = await response.json();
  if (!response.ok || !body.token) throw new Error('Open Reports and sign in before reviewing vehicle history.');
  token = body.token;
  sessionStorage.setItem('field-report.session', token);
  return token;
}

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    ...options,
    headers: { authorization: `Bearer ${await sessionToken()}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.error_code || response.status}: ${payload.data?.message || 'Request failed'}`);
  return payload.data;
}

async function loadReports() {
  const select = byId('report');
  select.replaceChildren();
  const { sessions } = await api('/api/report-sessions');
  const eligible = sessions.filter((session) => session.phase === 'CONFIRMED' && session.snapshot_ref && !session.job_context_binding);
  for (const session of eligible) {
    const option = document.createElement('option');
    option.value = session.session_id;
    option.textContent = `${session.report_name || session.session_id} · ${session.session_id}`;
    select.append(option);
  }
  byId('review-status').textContent = eligible.length ? 'Select a report and check its confirmed contents before linking.' : 'No confirmed reports without work orders are available.';
  if (eligible.length) await previewReport();
}

async function previewReport() {
  const sessionId = byId('report').value;
  if (!sessionId) return;
  try {
    const report = await api(`/api/report-sessions/${encodeURIComponent(sessionId)}/structured-export`);
    byId('report-preview').textContent = `Snapshot ${report.source_snapshot_id}\n${report.fields.map((field) => `${field.field_id}: ${field.state === 'KNOWN_VALUE' ? String(field.value) : field.state}`).join('\n')}`;
  } catch (error) { byId('report-preview').textContent = error.message; }
}

byId('report').addEventListener('change', previewReport);

byId('review-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = byId('review-status');
  try {
    const sessionId = byId('report').value;
    if (!sessionId) throw new Error('Select a confirmed report.');
    const { link } = await api(`/api/report-sessions/${encodeURIComponent(sessionId)}/vehicle-identity-review`, {
      method: 'POST', body: {
        vehicle_id: byId('vehicle-id').value.trim(),
        review_note: byId('review-note').value.trim(),
        attested: byId('attested').checked,
      },
    });
    status.textContent = `Linked ${link.report_id} to ${link.vehicle_id}. Review record: ${link.identity_review_hash}`;
    byId('lookup-id').value = link.vehicle_id;
  } catch (error) { status.textContent = error.message; }
});

byId('lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const results = byId('history-results');
  results.replaceChildren();
  try {
    const { vehicle_id: vehicleId, reports } = await api(`/api/vehicles/${encodeURIComponent(byId('lookup-id').value.trim())}/reports`);
    byId('lookup-status').textContent = `${vehicleId}: ${reports.length} confirmed report(s).`;
    for (const report of reports) {
      const item = document.createElement('li');
      item.textContent = `${report.report_id} · confirmed ${report.confirmed_at} · snapshot ${report.snapshot_id}`;
      results.append(item);
    }
  } catch (error) { byId('lookup-status').textContent = error.message; }
});

loadReports().catch((error) => { byId('review-status').textContent = error.message; });

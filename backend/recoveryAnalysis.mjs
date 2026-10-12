/** Cancellation covers provider I/O and the analysis/audit transaction. */
export function createAnalysisRequest(req, res, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController(); let disconnected = false, timedOut = false;
  const abort = () => { disconnected = true; controller.abort(); };
  const close = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort); res.once('close', close);
  if (req.aborted || res.destroyed) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); timer.unref?.();
  return {
    signal: controller.signal,
    get disconnected() { return disconnected; },
    get timedOut() { return timedOut; },
    assertActive() { if (controller.signal.aborted) throw Object.assign(new Error(timedOut ? 'OpenRouter timed out. Please try again.' : 'AI request cancelled'), { status: timedOut ? 504 : 499, name: timedOut ? 'TimeoutError' : 'AbortError' }); },
    dispose() { clearTimeout(timer); req.removeListener('aborted', abort); res.removeListener('close', close); },
  };
}

const invalid = (message, status = 422) => Object.assign(new Error(message), { status });
export function validateRecoveryFields(feature, input, required = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Field values must be an object');
  const allowed = new Set(feature.fields.map(field => field.key));
  if (Object.keys(input).some(key => !allowed.has(key))) throw invalid('Unknown domain input field');
  const result = {};
  for (const field of feature.fields) {
    const value = input[field.key];
    if (value == null || value === '') { if (required && field.required) throw invalid(`${field.label} is required`); continue; }
    if (['number', 'currency'].includes(field.type)) {
      if (!['string', 'number'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e12 || field.min != null && Number(value) < Number(field.min) || field.max != null && Number(value) > Number(field.max)) throw invalid(`${field.label} must be a valid number in its declared range`);
      if (field.type === 'currency' && !/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw invalid(`${field.label} supports at most two decimal places`);
    } else if (field.type === 'select') {
      if (!field.options.includes(value)) throw invalid(`Choose a valid ${field.label}`);
    } else if (field.type === 'date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw invalid(`${field.label} must be a valid date`);
    } else if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw invalid(`${field.label} must contain 1–20,000 characters`);
    result[field.key] = value;
  }
  return result;
}

/** Keep actual structured values for the renderer; never manufacture confidence or a successful report. */
export function normalizeRecoveryReport(raw, feature, model, provider = 'OpenRouter') {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw; }
  catch { throw invalid('OpenRouter returned an invalid report. No analysis was saved.', 502); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('OpenRouter returned an invalid report', 502);
  for (const key of ['headline', 'executiveSummary']) if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 20000) throw invalid(`The report is missing ${key}`, 502);
  for (const key of ['metrics', 'sections', 'actions']) if (!Array.isArray(data[key]) || data[key].length > 50) throw invalid(`The report contains invalid ${key}`, 502);
  if (!data.metrics.every(item => item && typeof item.label === 'string' && item.label.trim() && item.value != null)) throw invalid('The report contains invalid metrics', 502);
  if (!data.sections.every(item => item && typeof item.title === 'string' && item.title.trim() && item.detail != null)) throw invalid('The report contains invalid sections', 502);
  if (data.actions.some(item => item == null || item === '')) throw invalid('The report contains invalid actions', 502);
  const risk = ['Low', 'Moderate', 'High', 'Critical'].find(value => value.toLowerCase() === String(data.risk || '').toLowerCase()) || 'Not assessed';
  return { ...data, headline: data.headline.trim(), executiveSummary: data.executiveSummary.trim(), risk, confidence: null, provider, model,
    status: provider === 'OpenRouter' ? 'draft' : 'calculation',
    disclaimer: provider === 'OpenRouter' ? 'AI draft based on the entered fields. A qualified reviewer must validate source evidence and approve any operational action. Confidence and realized financial outcomes have not been measured.' : 'Local calculation based on the entered fields and configured domain rules. Validate source evidence before making an operational decision.' };
}

export function createRecoveryAnalysisHandler({ pool, featureById, runAI, accountScoped = false, validateInputs = validateRecoveryFields, timeoutMs = 60000 }) {
  return async (req, res, next) => {
    const request = createAnalysisRequest(req, res, { timeoutMs }); let client, open = false;
    try {
      const feature = featureById(req.params.id);
      const values = validateInputs(feature, req.body.values || {}, true);
      const type = String(req.body.analysisType || 'risk-and-value');
      if (!type.trim() || type.length > 200) throw invalid('Invalid analysis type');
      request.assertActive();
      const existingActor = (await pool.query('SELECT id,email,role' + (accountScoped ? ',account_id' : '') + ' FROM app_users WHERE id=$1', [req.user.id])).rows[0];
      if (!existingActor || (accountScoped && existingActor.account_id !== req.user.account_id)) throw invalid('Account no longer exists or access changed', 401);
      request.assertActive();
      const result = await runAI(feature, values, type, request.signal); request.assertActive();
      client = await pool.connect(); request.assertActive(); await client.query('BEGIN'); open = true; request.assertActive();
      const actor = (await client.query('SELECT id,email,role' + (accountScoped ? ',account_id' : '') + ' FROM app_users WHERE id=$1 FOR SHARE', [req.user.id])).rows[0];
      if (!actor || (accountScoped && actor.account_id !== req.user.account_id)) throw invalid('Account no longer exists or access changed', 401);
      request.assertActive();
      const reference = req.body.reference == null || req.body.reference === '' ? null : String(req.body.reference);
      if (reference) {
        const found = (await client.query('SELECT id FROM feature_records WHERE feature_id=$1 AND reference=$2' + (accountScoped ? ' AND account_id=$3' : ''), [feature.id, reference, ...(accountScoped ? [actor.account_id] : [])])).rows[0];
        if (!found) throw invalid('Select an existing record from this capability', 422);
      }
      request.assertActive();
      await client.query(accountScoped ? 'INSERT INTO analysis_results(account_id,feature_id,record_reference,analysis_type,provider,model,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)' : 'INSERT INTO analysis_results(feature_id,record_reference,analysis_type,provider,model,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [...(accountScoped ? [actor.account_id] : []), feature.id, reference, type, result.provider, result.model, result, actor.email]);
      request.assertActive();
      await client.query(accountScoped ? 'INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)' : 'INSERT INTO audit_events(actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5)', [...(accountScoped ? [actor.account_id] : []), actor.email, 'analyzed', 'ai_analysis', feature.id, `Completed ${type} using ${result.provider} ${result.model}.`]);
      request.assertActive(); await client.query('COMMIT'); open = false; request.assertActive(); res.json({ result });
    } catch (error) {
      if (open) { await client.query('ROLLBACK').catch(() => {}); open = false; }
      if (!request.disconnected) next(request.timedOut ? invalid('OpenRouter timed out. Please try again.', 504) : error);
    } finally { if (open) await client?.query('ROLLBACK').catch(() => {}); client?.release(); request.dispose(); }
  };
}

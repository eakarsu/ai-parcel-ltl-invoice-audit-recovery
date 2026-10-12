import { validateRecoveryFields } from './recoveryAnalysis.mjs';

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const workflowStates = ['Open', 'Investigating', 'Review', 'Approved', 'Closed'];
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function identifier(value) { const id = String(value || ''); if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw fail('Invalid record ID'); return id; }
function version(body, row) { if (typeof body.recordVersion !== 'string' || body.recordVersion !== row.record_version) throw fail('This record changed. Reload it before saving or deleting.', 409); }
function defaultTransition(user, row, next) {
  const states = { Open: ['Investigating', 'Review'], Investigating: ['Open', 'Review'], Review: ['Investigating', 'Approved'], Approved: ['Closed'], Closed: [] };
  if (!states[row.status]?.includes(next)) throw fail(`Cannot move from ${row.status} to ${next}`, 409);
  if (next === 'Approved' ? !['admin', 'reviewer'].includes(user.role) : !['admin', 'operator'].includes(user.role)) throw fail(next === 'Approved' ? 'Reviewer role required' : 'Operator role required', 403);
}

/** Only ordinary feature records are mutable; native source, claim, rule and audit endpoints stay intact. */
export function mountRecoveryRecordActions(app, { pool, auth, featureById, accountScoped = false, validateInputs = validateRecoveryFields, authorizeTransition = defaultTransition, dependencies = [] }) {
  for (const dependency of dependencies) if (!['statement_lines', 'recovery_claims', 'cam_rules'].includes(dependency)) throw new Error('Unknown recovery evidence dependency');
  const scope = accountScoped ? ' AND account_id=$3' : '';
  const params = (user, feature, id) => [id, feature.id, ...(accountScoped ? [user.account_id] : [])];
  async function actor(client, req, lock = false) {
    if (!req.user?.id) throw fail('Authentication required', 401);
    const user = (await client.query('SELECT id,email,name,role' + (accountScoped ? ',account_id' : '') + ' FROM app_users WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [req.user.id])).rows[0];
    if (!user || (accountScoped && user.account_id !== req.user.account_id)) throw fail('Account no longer exists or access changed', 401);
    return user;
  }
  async function fetchRecord(client, user, feature, id, lock = false) {
    const item = (await client.query('SELECT *,xmin::text AS record_version FROM feature_records WHERE id=$1 AND feature_id=$2' + scope + (lock ? ' FOR UPDATE' : ''), params(user, feature, identifier(id)))).rows[0];
    if (!item) throw fail('Record not found', 404); return item;
  }
  async function permissions(client, user, feature, item) {
    let reason = feature.immutable || feature.readOnly ? 'This register retains immutable evidence.' : ['Approved', 'Closed'].includes(item.status) ? 'Approved and closed cases retain finalized evidence. Use a permitted workflow transition before making any amendment.' : '';
    if (!reason) {
      const linkedAnalysis = (await client.query('SELECT 1 FROM analysis_results WHERE feature_id=$1 AND record_reference=$2' + (accountScoped ? ' AND account_id=$3' : '') + ' LIMIT 1', [feature.id, item.reference, ...(accountScoped ? [user.account_id] : [])])).rows.length;
      if (linkedAnalysis) reason = 'A retained analysis references this case. Its source fields must remain attributable.';
    }
    for (const table of dependencies) {
      const key = table === 'cam_rules' ? 'case_reference' : 'record_reference';
      if ((await client.query(`SELECT 1 FROM ${table} WHERE account_id=$1 AND ${key}=$2 LIMIT 1`, [user.account_id, item.reference])).rows.length) { reason = 'Imported evidence, rules or claims reference this case. Retain the case and amend through its native evidence workflow.'; break; }
    }
    const allowedTransitions = [];
    if (!feature.immutable && !feature.readOnly) for (const status of workflowStates) { try { authorizeTransition(user, item, status); allowedTransitions.push(status); } catch { /* Only native-authorized state changes are exposed. */ } }
    return { canEdit: !reason && ['admin', 'operator'].includes(user.role), canDelete: !reason && user.role === 'admin', reason, allowedTransitions, accountScoped };
  }
  async function audit(client, user, action, row, detail) {
    await client.query(accountScoped ? 'INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)' : 'INSERT INTO audit_events(actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5)', [...(accountScoped ? [user.account_id] : []), user.email, action, 'feature_record', row.reference, detail]);
  }
  app.get('/api/features/:id/records/:recordId', auth, async (req, res, next) => {
    try { const feature = featureById(req.params.id), user = await actor(pool, req), item = await fetchRecord(pool, user, feature, req.params.recordId); res.json({ item, permissions: await permissions(pool, user, feature, item) }); } catch (error) { next(error); }
  });
  app.put('/api/features/:id/records/:recordId', auth, async (req, res, next) => {
    let client, open = false;
    try {
      const feature = featureById(req.params.id); client = await pool.connect(); await client.query('BEGIN'); open = true;
      const user = await actor(client, req, true), item = await fetchRecord(client, user, feature, req.params.recordId, true), policy = await permissions(client, user, feature, item);
      if (!policy.canEdit) throw fail(policy.reason || 'Editing requires an administrator or operator', 403);
      const body = req.body || {}; version(body, item);
      const allowed = new Set(['recordVersion', 'title', 'owner', 'due_date', 'values', ...(accountScoped ? [] : ['risk', 'amount'])]);
      if (Object.keys(body).some(key => !allowed.has(key))) throw fail('Unknown or protected record field');
      const title = String(body.title || '').trim(), owner = String(body.owner || '').trim();
      if (!title || title.length > (accountScoped ? 1000 : 300) || !owner || owner.length > 200) throw fail('A valid title and owner are required');
      if (!date(body.due_date)) throw fail('Choose a valid due date');
      const fieldKeys = new Set(feature.fields.map(field => field.key));
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values) || Object.keys(body.values).some(key => !fieldKeys.has(key))) throw fail('Unknown domain field');
      const values = validateInputs(feature, body.values, true);
      const metadata = Object.fromEntries(Object.entries(item.payload || {}).filter(([key]) => !fieldKeys.has(key)));
      if (accountScoped) metadata.__version = (item.payload?.__version ?? 0) + 1;
      const amount = accountScoped ? Number(feature.amountField ? values[feature.amountField] ?? 0 : 0) : Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount >= 1e14 || !/^\d+(?:\.\d{1,2})?$/.test(String(amount))) throw fail('Amount must be nonnegative with at most two decimal places');
      const risk = accountScoped ? item.risk : body.risk;
      if (!accountScoped && !['Low', 'Moderate', 'High', 'Critical'].includes(risk)) throw fail('Invalid risk');
      const changed = (await client.query('UPDATE feature_records SET title=$1,owner=$2,due_date=$3,amount=$4,risk=$5,payload=$6,updated_at=clock_timestamp() WHERE id=$7 AND feature_id=$8' + (accountScoped ? ' AND account_id=$9' : '') + ' RETURNING *,xmin::text AS record_version', [title, owner, body.due_date, amount, risk, { ...metadata, ...values }, item.id, feature.id, ...(accountScoped ? [user.account_id] : [])])).rows[0];
      await audit(client, user, 'edited', changed, `Edited ${feature.title} operational case; reference, creator and workflow approval evidence retained.`);
      await client.query('COMMIT'); open = false; res.json({ item: changed, message: 'Record updated' });
    } catch (error) { if (open) await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client?.release(); }
  });
  app.delete('/api/features/:id/records/:recordId', auth, async (req, res, next) => {
    let client, open = false;
    try {
      const feature = featureById(req.params.id); client = await pool.connect(); await client.query('BEGIN'); open = true;
      const user = await actor(client, req, true), item = await fetchRecord(client, user, feature, req.params.recordId, true), policy = await permissions(client, user, feature, item);
      if (!policy.canDelete) throw fail(policy.reason || 'Deletion requires an administrator', 403);
      version(req.body || {}, item); if (Object.keys(req.body || {}).some(key => key !== 'recordVersion')) throw fail('Unknown deletion field');
      await client.query('DELETE FROM feature_records WHERE id=$1 AND feature_id=$2' + scope, params(user, feature, item.id));
      await audit(client, user, 'deleted', item, `Deleted ${feature.title} operational case; retained its audit history.`);
      await client.query('COMMIT'); open = false; res.json({ deleted: true, message: 'Record deleted' });
    } catch (error) { if (open) await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client?.release(); }
  });
  if (!accountScoped) app.post('/api/features/:id/records/:recordId/transition', auth, async (req, res, next) => {
    let client, open = false;
    try {
      const feature = featureById(req.params.id); if (feature.immutable || feature.readOnly) throw fail('This register retains immutable evidence', 403);
      client = await pool.connect(); await client.query('BEGIN'); open = true;
      const user = await actor(client, req, true), item = await fetchRecord(client, user, feature, req.params.recordId, true); version(req.body || {}, item); authorizeTransition(user, item, req.body.status);
      const changed = (await client.query('UPDATE feature_records SET status=$1,updated_at=clock_timestamp() WHERE id=$2 AND feature_id=$3 RETURNING *,xmin::text AS record_version', [req.body.status, item.id, feature.id])).rows[0];
      await audit(client, user, 'transitioned', changed, `Moved from ${item.status} to ${changed.status}.`); await client.query('COMMIT'); open = false; res.json({ item: changed, message: `Advanced to ${changed.status}` });
    } catch (error) { if (open) await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client?.release(); }
  });
  app.get('/api/features/:id/analyses', auth, async (req, res, next) => {
    try { const feature = featureById(req.params.id), user = await actor(pool, req); const items = (await pool.query('SELECT id,feature_id,record_reference,analysis_type,provider,model,result,created_at FROM analysis_results WHERE feature_id=$1 AND created_by=$2' + (accountScoped ? ' AND account_id=$3' : '') + ' ORDER BY created_at DESC,id DESC LIMIT 100', [feature.id, user.email, ...(accountScoped ? [user.account_id] : [])])).rows; res.json({ items }); } catch (error) { next(error); }
  });
}

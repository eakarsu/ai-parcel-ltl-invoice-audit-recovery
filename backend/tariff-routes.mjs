import { createHash } from 'node:crypto';
import { amount, invalid } from './recovery-domain.mjs';
import { assessSurcharge, percentUnits, tariffDate, tariffKey } from './tariff-engine.mjs';

const id = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw invalid('Invalid tariff source or rule id', 400); return n; };
const valueText = (value, label, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw invalid(`${label} must contain ${min}–${max} characters`);
  return value.trim();
};
const role = (user, allowed) => { if (!allowed.includes(user.role)) throw invalid('This role cannot change tariff rules', 403); };
async function audit(client, user, action, reference, detail) {
  await client.query('INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [user.account_id, user.email, action, 'parcel_tariff', String(reference), JSON.stringify(detail)]);
}
function citedTerm(quote, carrier, chargeType, method, rate) {
  if (!tariffKey(quote).includes(tariffKey(carrier)) || !tariffKey(quote).includes(tariffKey(chargeType)))
    throw invalid('Exact tariff line must name the carrier and charge type');
  if (method === 'PERCENT_OF_BASE') {
    const rates = [...quote.matchAll(/\b(\d+(?:\.\d{1,4})?)\s*(?:%|percent\b)/gi)];
    if (!rates.some(match => Math.abs(Number(match[1]) - Number(rate)) < 0.000001) || !/base\s+freight/i.test(quote))
      throw invalid('Fuel tariff line must state the cited percentage of base freight');
  } else {
    const prices = [...quote.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)];
    if (!prices.some(match => Math.abs(Number(match[1]) - Number(rate)) < 0.000001) || !/per\s+shipment/i.test(quote))
      throw invalid('Fixed accessorial tariff line must state the dollar amount per shipment');
  }
}

export function mountTariffRoutes(app, { pool, auth }) {
  app.get('/api/parcel/cases', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,reference,feature_id,title,payload->>'carrier' AS carrier
        FROM feature_records WHERE account_id=$1 AND feature_id IN ('fuel-surcharge-audit','accessorial-charge-validation')
        AND coalesce(payload->>'__example','false')<>'true' ORDER BY updated_at DESC,id DESC LIMIT 300`,
      [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/parcel/tariff-sources', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,source_file,content_hash,created_by_id,created_at
        FROM parcel_tariff_sources WHERE account_id=$1 ORDER BY id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/parcel/tariff-sources/:id', auth, async (req, res, next) => {
    try {
      const source = (await pool.query('SELECT * FROM parcel_tariff_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, id(req.params.id)])).rows[0];
      if (!source) throw invalid('Tariff source not found', 404);
      res.json({ source });
    } catch (error) { next(error); }
  });
  app.post('/api/parcel/tariff-sources', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const sourceFile = valueText(req.body?.sourceFile, 'Rate-card file name', 3, 200);
      const content = req.body?.content;
      if (typeof content !== 'string' || content.trim().length < 30 || content.length > 500000)
        throw invalid('Rate-card text must contain 30–500,000 characters');
      if (!/\.(csv|txt)$/i.test(sourceFile)) throw invalid('Import a CSV or text rate card');
      const hash = createHash('sha256').update(content).digest('hex');
      client = await pool.connect(); await client.query('BEGIN');
      const source = (await client.query(`INSERT INTO parcel_tariff_sources(account_id,source_file,content,content_hash,created_by_id)
        VALUES($1,$2,$3,$4,$5) RETURNING id,source_file,content_hash,created_by_id,created_at`,
      [req.user.account_id, sourceFile, content, hash, req.user.id])).rows[0];
      await audit(client, req.user, 'tariff_source_imported', source.id, { sourceFile, hash,
        scope: 'Operator-imported tariff text; carrier source authenticity not verified' });
      await client.query('COMMIT'); res.status(201).json({ source });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });

  app.get('/api/parcel/tariff-rules', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT rule.*,source.source_file,source.content_hash AS source_hash
        FROM parcel_tariff_rules rule JOIN parcel_tariff_sources source ON source.id=rule.source_id AND source.account_id=rule.account_id
        WHERE rule.account_id=$1 ORDER BY rule.id DESC LIMIT 300`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/parcel/tariff-rules', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const body = req.body || {};
      const carrierLabel = valueText(body.carrier, 'Carrier', 2, 200);
      const chargeTypeLabel = valueText(body.chargeType, 'Charge type', 2, 200);
      const carrier = tariffKey(carrierLabel), chargeType = tariffKey(chargeTypeLabel);
      const featureId = String(body.featureId ?? '');
      const method = featureId === 'fuel-surcharge-audit' ? 'PERCENT_OF_BASE'
        : featureId === 'accessorial-charge-validation' ? 'FIXED_PER_SHIPMENT' : null;
      if (!method) throw invalid('Choose a fuel or accessorial tariff capability');
      const effectiveOn = tariffDate(body.effectiveOn, 'Tariff effective date');
      const expiresOn = tariffDate(body.expiresOn, 'Tariff expiry date');
      if (effectiveOn > expiresOn) throw invalid('Tariff expiry must be on or after effective date');
      const rate = String(body.rate ?? '').trim();
      const units = method === 'PERCENT_OF_BASE' ? percentUnits(rate) : null;
      const fixedCents = method === 'FIXED_PER_SHIPMENT' ? amount(rate, 'Fixed per-shipment tariff') : null;
      const sourceId = id(body.sourceId);
      client = await pool.connect(); await client.query('BEGIN');
      const caseRow = (await client.query(`SELECT id FROM feature_records WHERE account_id=$1 AND feature_id=$2
        AND lower(trim(regexp_replace(coalesce(payload->>'carrier',''),'[[:space:]]+',' ','g')))=$3
        AND coalesce(payload->>'__example','false')<>'true' LIMIT 1`,
      [req.user.account_id, featureId, carrier])).rows[0];
      if (!caseRow) throw invalid('Create a real case for this carrier and capability first', 409);
      const source = (await client.query('SELECT * FROM parcel_tariff_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, sourceId])).rows[0];
      if (!source) throw invalid('Select a rate card imported in this customer account', 409);
      const quote = valueText(body.sourceQuote, 'Exact tariff line', 20, 5000);
      const sourceLine = source.content.split(/\r?\n/).findIndex(line => line.trim() === quote);
      if (sourceLine < 0) throw invalid('Tariff quote must exactly match one line in the imported rate card');
      if (!quote.includes(effectiveOn) || !quote.includes(expiresOn))
        throw invalid('Tariff line must state both effective dates in YYYY-MM-DD form');
      citedTerm(quote, carrierLabel, chargeTypeLabel, method, rate);
      const version = Number((await client.query(`SELECT coalesce(max(version),0)+1 AS version FROM parcel_tariff_rules
        WHERE account_id=$1 AND carrier_key=$2 AND feature_id=$3 AND charge_type_key=$4`,
      [req.user.account_id, carrier, featureId, chargeType])).rows[0].version);
      const rule = (await client.query(`INSERT INTO parcel_tariff_rules(account_id,carrier_key,carrier_label,feature_id,
        charge_type_key,charge_type_label,method,percent_units,fixed_cents,effective_on,expires_on,
        source_id,source_line,source_quote,version,created_by_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.user.account_id, carrier, carrierLabel, featureId, chargeType, chargeTypeLabel, method, units,
        fixedCents, effectiveOn, expiresOn, sourceId, sourceLine + 1, quote, version, req.user.id])).rows[0];
      await audit(client, req.user, 'tariff_rule_drafted', rule.id, { carrier, chargeType, version,
        sourceId, sourceLine: sourceLine + 1, sourceHash: source.content_hash,
        scope: 'Draft rule from an exact line in operator-imported carrier text' });
      await client.query('COMMIT'); res.status(201).json({ rule });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Concurrent tariff version; reload and retry', 409) : error); }
    finally { client?.release(); }
  });
  app.post('/api/parcel/tariff-rules/:id/approve', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'reviewer']);
      const ruleId = id(req.params.id), rationale = valueText(req.body?.rationale, 'Independent review rationale', 20, 2000);
      client = await pool.connect(); await client.query('BEGIN');
      const rule = (await client.query('SELECT * FROM parcel_tariff_rules WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [req.user.account_id, ruleId])).rows[0];
      if (!rule) throw invalid('Tariff rule not found', 404);
      if (rule.status !== 'DRAFT') throw invalid('Only a draft tariff rule can be approved', 409);
      if (String(rule.created_by_id) === String(req.user.id)) throw invalid('Tariff creator cannot approve their own rule', 403);
      const currentVersion = Number((await client.query(`SELECT coalesce(max(version),0) AS version FROM parcel_tariff_rules
        WHERE account_id=$1 AND carrier_key=$2 AND feature_id=$3 AND charge_type_key=$4 AND status='APPROVED'`,
      [req.user.account_id, rule.carrier_key, rule.feature_id, rule.charge_type_key])).rows[0].version);
      if (currentVersion >= Number(rule.version)) throw invalid('A newer tariff version is already approved', 409);
      await client.query(`UPDATE parcel_tariff_rules SET status='SUPERSEDED' WHERE account_id=$1 AND carrier_key=$2
        AND feature_id=$3 AND charge_type_key=$4 AND status='APPROVED'`,
      [req.user.account_id, rule.carrier_key, rule.feature_id, rule.charge_type_key]);
      const approved = (await client.query(`UPDATE parcel_tariff_rules SET status='APPROVED',approved_by_id=$1,
        approved_at=now() WHERE account_id=$2 AND id=$3 RETURNING *`, [req.user.id, req.user.account_id, ruleId])).rows[0];
      await audit(client, req.user, 'tariff_rule_approved', ruleId, { version: rule.version, rationale,
        scope: 'Independent review of operator-imported tariff line; carrier authenticity not verified' });
      await client.query('COMMIT'); res.json({ rule: approved });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Another tariff version was approved concurrently', 409) : error); }
    finally { client?.release(); }
  });
  app.get('/api/parcel/tariff-rules/:id/assessments', auth, async (req, res, next) => {
    try {
      const ruleId = id(req.params.id);
      if (!(await pool.query('SELECT id FROM parcel_tariff_rules WHERE account_id=$1 AND id=$2', [req.user.account_id, ruleId])).rowCount)
        throw invalid('Tariff rule not found', 404);
      const items = (await pool.query(`SELECT assessment.*,line.source_file,line.line_number,line.checksum,line.amount,line.statement_date
        FROM parcel_surcharge_assessments assessment JOIN statement_lines line ON line.id=assessment.statement_line_id AND line.account_id=assessment.account_id
        WHERE assessment.account_id=$1 AND assessment.rule_id=$2 ORDER BY assessment.id DESC LIMIT 500`,
      [req.user.account_id, ruleId])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/parcel/tariff-rules/:id/assess', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator', 'reviewer']);
      const ruleId = id(req.params.id);
      client = await pool.connect(); await client.query('BEGIN');
      const rule = (await client.query(`SELECT rule.*,source.content_hash AS source_hash FROM parcel_tariff_rules rule
        JOIN parcel_tariff_sources source ON source.id=rule.source_id AND source.account_id=rule.account_id
        WHERE rule.account_id=$1 AND rule.id=$2 FOR UPDATE OF rule`, [req.user.account_id, ruleId])).rows[0];
      if (!rule) throw invalid('Tariff rule not found', 404);
      if (rule.status !== 'APPROVED') throw invalid('Only approved tariffs can assess imported invoice lines', 409);
      const lines = (await client.query(`WITH eligible AS (
        SELECT line.*,count(*) OVER(PARTITION BY line.record_reference,
          lower(trim(regexp_replace(coalesce(line.provenance->>'chargeType',''),'[[:space:]]+',' ','g')))) AS charge_line_count
        FROM statement_lines line JOIN feature_records record ON record.account_id=line.account_id
          AND record.reference=line.record_reference AND record.feature_id=line.feature_id
        WHERE line.account_id=$1 AND line.feature_id=$2
          AND lower(trim(regexp_replace(coalesce(record.payload->>'carrier',''),'[[:space:]]+',' ','g')))=$3
          AND coalesce(record.payload->>'__example','false')<>'true'
          AND lower(trim(regexp_replace(coalesce(line.provenance->>'chargeType',''),'[[:space:]]+',' ','g')))=$4
          AND line.statement_date BETWEEN $5 AND $6
          AND line.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored')
      ) SELECT eligible.* FROM eligible
      LEFT JOIN parcel_surcharge_assessments prior ON prior.statement_line_id=eligible.id AND prior.rule_id=$7 AND prior.account_id=eligible.account_id
      WHERE prior.id IS NULL ORDER BY eligible.id LIMIT 1001`,
      [req.user.account_id, rule.feature_id, rule.carrier_key, rule.charge_type_key,
        rule.effective_on, rule.expires_on, rule.id])).rows;
      let assessed = 0;
      for (const line of lines.slice(0, 1000)) {
        const result = assessSurcharge(rule, line);
        if (Number(line.charge_line_count) > 1 && result.status === 'CANDIDATE') {
          result.status = 'INSUFFICIENT'; result.varianceCents = null;
          result.calculation.reason = 'Multiple positive lines share this shipment case and charge type; resolve duplicates before claiming';
        }
        const saved = await client.query(`INSERT INTO parcel_surcharge_assessments(account_id,rule_id,statement_line_id,
          observed_cents,expected_cents,variance_cents,status,calculation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(rule_id,statement_line_id) DO NOTHING RETURNING id`,
        [req.user.account_id, rule.id, line.id, result.observedCents, result.expectedCents,
          result.varianceCents, result.status, { ...result.calculation, sourceId: rule.source_id,
            sourceHash: rule.source_hash, sourceLine: rule.source_line, sourceQuote: rule.source_quote }]);
        if (saved.rowCount) assessed++;
      }
      if (assessed) await audit(client, req.user, 'tariff_lines_assessed', ruleId, { assessed, version: rule.version,
        scope: 'Immutable imported-line assessment; no carrier claim or credit verified' });
      await client.query('COMMIT'); res.json({ ruleId, newAssessments: assessed, reviewedLines: Math.min(lines.length, 1000), hasMore: lines.length > 1000 });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });
}

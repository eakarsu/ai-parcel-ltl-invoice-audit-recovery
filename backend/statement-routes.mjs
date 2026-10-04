/**
 * Statement ingestion routes. Closes the "real statement ingestion" launch
 * condition. Parsed statement lines and their reconciliation are persisted
 * with provenance, so every confirmed figure can be traced to the source line
 * and the configured recovery rule that supports it. Idempotent on the
 * statement checksum: re-uploading a file cannot create records twice.
 */
import { ingestStatement } from './statement-ingest.mjs';
import { invalid, recoveryRuleFor } from './recovery-domain.mjs';

const RECONCILIATION_BUCKETS = ['confirmed', 'matched', 'assumed', 'credits', 'noRecovery', 'ignored', 'unmatched'];

export function mountStatementRoutes(app, { pool, config, auth, featureById }) {
  app.post('/api/features/:id/ingest', auth, async (req, res, next) => {
    let client;
    try {
      const feature = featureById(req.params.id);
      if (!['admin', 'operator'].includes(req.user.role)) throw invalid('Operator role required', 403);
      const text = String(req.body.text ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'text (statement contents) is required' });

      const records = (await pool.query('SELECT reference, status, amount, payload FROM feature_records WHERE account_id=$1 AND feature_id=$2', [req.user.account_id, feature.id])).rows;
      const governedTariff = ['fuel-surcharge-audit', 'accessorial-charge-validation'].includes(feature.id);
      const rule = governedTariff ? null : recoveryRuleFor(config, feature);
      const preview = ingestStatement({ text, format: req.body.format, sourceFile: req.body.sourceFile, records, rule,
        allowMultipleLines: governedTariff });

      const prior = (await pool.query('SELECT id,source_file,row_count,reconciliation FROM statement_ingests WHERE account_id=$1 AND feature_id=$2 AND checksum=$3', [req.user.account_id, feature.id, preview.checksum])).rows[0];
      if (prior) {
        const rejected = (await pool.query(
          "SELECT line_number AS line,rejection_reason AS reason FROM statement_lines WHERE account_id=$1 AND ingest_id=$2 AND reconciliation_status='rejected' ORDER BY line_number",
          [req.user.account_id, prior.id],
        )).rows;
        return res.json({
          checksum: preview.checksum, sourceFile: prior.source_file, format: preview.format,
          parsed: { rowCount: prior.row_count, rejected }, reconciliation: prior.reconciliation,
          ingestId: prior.id, alreadyIngested: true,
          note: 'This statement was already ingested for this capability; showing the saved reconciliation.',
        });
      }

      const outcomes = new Map();
      for (const bucket of RECONCILIATION_BUCKETS) for (const entry of preview.reconciliation[bucket]) outcomes.set(entry.line, entry);

      client = await pool.connect();
      await client.query('BEGIN');
      const ingest = (await client.query(
        `INSERT INTO statement_ingests(account_id,checksum,source_file,feature_id,row_count,rejected_count,assumed_count,confirmed_recovery,created_by,reconciliation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.user.account_id, preview.checksum, preview.sourceFile, feature.id, preview.parsed.rowCount, preview.parsed.rejected.length, preview.reconciliation.summary.assumedEntries, preview.reconciliation.summary.confirmedRecovery, req.user.email, preview.reconciliation],
      )).rows[0];
      for (const row of preview.rows) {
        const outcome = outcomes.get(row.line) ?? {};
        await client.query(
          `INSERT INTO statement_lines(account_id,ingest_id,feature_id,source_file,checksum,line_number,reference,description,amount,currency,statement_date,reconciliation_status,record_reference,expected_amount,delta,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [req.user.account_id, ingest.id, feature.id, preview.sourceFile, preview.checksum, row.line, row.reference, row.description, row.amount, row.currency, row.date, outcome.status ?? 'unclassified', outcome.recordReference ?? null, outcome.expectedAmount ?? null, outcome.signedRecovery ?? null, { sourceFile: preview.sourceFile, line: row.line, checksum: preview.checksum, rule: preview.reconciliation.rule, chargeType: row.chargeType, baseFreightAmount: row.baseFreightAmount }],
        );
      }
      for (const rejected of preview.parsed.rejected) {
        await client.query(
          `INSERT INTO statement_lines(account_id,ingest_id,feature_id,source_file,checksum,line_number,reference,description,amount,reconciliation_status,rejection_reason,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,'rejected',$9,$10)`,
          [req.user.account_id, ingest.id, feature.id, preview.sourceFile, preview.checksum, rejected.line, `rejected-line-${rejected.line}`, String(rejected.raw ?? ''), rejected.reason, { sourceFile: preview.sourceFile, line: rejected.line, checksum: preview.checksum, raw: rejected.raw ?? null }],
        );
      }
      await client.query('INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)', [
        req.user.account_id, req.user.email, 'ingested', 'statement', feature.id,
        'Ingested ' + preview.parsed.rowCount + ' row(s) from ' + preview.sourceFile + ' (checksum ' + preview.checksum.slice(0, 12) + ', source-supported variance ' + preview.reconciliation.summary.confirmedRecovery + ')',
      ]);
      await client.query('COMMIT');
      res.status(201).json({ ...preview, ingestId: ingest.id, alreadyIngested: false });
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      next(error);
    } finally {
      client?.release();
    }
  });

  app.get('/api/statement-ingests', auth, async (req, res) => {
    const items = (await pool.query(`SELECT id,checksum,source_file,feature_id,row_count,rejected_count,assumed_count,confirmed_recovery,created_by,ingested_at,reconciliation->'summary' AS summary FROM statement_ingests WHERE account_id=$1 ORDER BY ingested_at DESC, id DESC LIMIT 200`, [req.user.account_id])).rows;
    res.json({ items });
  });

  app.get('/api/statement-ingests/:id', auth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw invalid('Invalid statement ingest id', 400);
      const item = (await pool.query('SELECT * FROM statement_ingests WHERE account_id=$1 AND id=$2', [req.user.account_id, id])).rows[0];
      if (!item) throw invalid('Statement ingest not found', 404);
      const lines = (await pool.query('SELECT * FROM statement_lines WHERE account_id=$1 AND ingest_id=$2 ORDER BY line_number', [req.user.account_id, id])).rows;
      res.json({ item, lines });
    } catch (error) {
      next(error);
    }
  });
}

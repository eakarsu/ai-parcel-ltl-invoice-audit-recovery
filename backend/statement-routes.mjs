/**
 * Statement ingestion routes. Closes the "real statement ingestion" launch
 * condition. Idempotent on the statement checksum: re-uploading a file cannot
 * create records twice. Reports only recovery a source line supports as
 * confirmed.
 */
import { ingestStatement } from './statement-ingest.mjs';

export function mountStatementRoutes(app, { pool, auth, audit, featureById }) {
  app.post('/api/features/:id/ingest', auth, async (req, res, next) => {
    try {
      const feature = featureById(req.params.id);
      const text = String(req.body.text ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'text (statement contents) is required' });

      const existing = (await pool.query('SELECT reference, amount FROM feature_records WHERE feature_id=$1', [feature.id])).rows;
      const preview = ingestStatement({
        text,
        format: req.body.format,
        sourceFile: req.body.sourceFile,
        records: existing,
      });

      const prior = (await pool.query('SELECT 1 FROM statement_ingests WHERE checksum=$1', [preview.checksum])).rows[0];
      if (prior) {
        return res.json({ ...preview, alreadyIngested: true, note: 'This statement checksum was already ingested; no records created.' });
      }

      await pool.query(
        'INSERT INTO statement_ingests(checksum, source_file, row_count, rejected_count, created_by) VALUES($1,$2,$3,$4,$5)',
        [preview.checksum, preview.sourceFile, preview.parsed.rowCount, preview.parsed.rejected.length, req.user.email],
      );
      await audit(
        req.user.email, 'ingested', 'statement', feature.id,
        'Ingested ' + preview.parsed.rowCount + ' row(s) from ' + preview.sourceFile + ' (checksum ' + preview.checksum.slice(0, 12) + ')',
      );
      res.status(201).json({ ...preview, alreadyIngested: false });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/statement-ingests', auth, async (_req, res) => {
    res.json({ items: (await pool.query('SELECT * FROM statement_ingests ORDER BY ingested_at DESC LIMIT 200')).rows });
  });
}

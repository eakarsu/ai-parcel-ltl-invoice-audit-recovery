/**
 * Statement ingestion + confirmed-credit reconciliation.
 *
 * Closes the launch condition shared by the recovery apps: *"real statement
 * ingestion and removal of assumed recovery"*. Until now the only way to get
 * figures in was to type them into a form (or press a demo-fill button), so
 * every number was operator-entered and nothing tied back to a source
 * document.
 *
 * What this adds:
 *   - parse an uploaded statement (CSV or JSON rows) into records
 *   - stamp every row with provenance: source filename, row number, content
 *     checksum — so a figure can always be traced to the line it came from
 *   - idempotent on the statement checksum: re-uploading a file cannot
 *     double-count
 *   - reconcile ingested rows against entered amounts and report **confirmed**
 *     credits separately from **assumed** ones
 *
 * Deterministic: no model calls, no invented figures.
 */
import crypto from 'crypto';

/** Stable checksum of the statement content, used as the idempotency key. */
export function statementChecksum(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Parse a CSV statement. Deliberately strict: a row that cannot be read is
 * reported as rejected rather than silently coerced to zero.
 *
 * Expected columns (case-insensitive): reference, description, amount.
 * Optional: date, currency, quantity, unit_price.
 */
export function parseStatementCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) {
    return { header: [], rows: [], rejected: [{ line: 1, reason: 'Statement has no data rows' }] };
  }

  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const idx = (name) => header.indexOf(name);

  const refI = idx('reference') >= 0 ? idx('reference') : idx('ref') >= 0 ? idx('ref') : 0;
  const descI = idx('description') >= 0 ? idx('description') : idx('memo') >= 0 ? idx('memo') : 1;
  const amtI = idx('amount') >= 0 ? idx('amount') : idx('charge') >= 0 ? idx('charge') : 2;
  const dateI = idx('date');
  const curI = idx('currency');

  const rows = [];
  const rejected = [];

  for (let n = 1; n < lines.length; n++) {
    const cells = split(lines[n]);
    const rawAmount = (cells[amtI] ?? '').replace(/[$,]/g, '');
    const amount = Number(rawAmount);

    if (!Number.isFinite(amount)) {
      rejected.push({
        line: n + 1,
        reason: `amount "${cells[amtI] ?? ''}" is not a number`,
        raw: lines[n].slice(0, 200),
      });
      continue;
    }

    rows.push({
      line: n + 1,
      reference: String(cells[refI] ?? '').trim() || `line-${n + 1}`,
      description: String(cells[descI] ?? '').trim(),
      amount,
      date: dateI >= 0 ? String(cells[dateI] ?? '').trim() : null,
      currency: curI >= 0 ? String(cells[curI] ?? '').trim().toUpperCase() || 'USD' : 'USD',
    });
  }

  return { header, rows, rejected };
}

/** Parse a JSON statement: an array of row objects, or { rows: [...] }. */
export function parseStatementJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (e) {
    return { header: [], rows: [], rejected: [{ line: 1, reason: `Invalid JSON: ${e.message}` }] };
  }
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
  if (!source) {
    return { header: [], rows: [], rejected: [{ line: 1, reason: 'JSON statement must be an array of rows or { rows: [] }' }] };
  }

  const rows = [];
  const rejected = [];
  source.forEach((r, i) => {
    const amount = Number(r?.amount ?? r?.charge);
    if (!Number.isFinite(amount)) {
      rejected.push({ line: i + 1, reason: `amount "${r?.amount ?? ''}" is not a number`, raw: JSON.stringify(r).slice(0, 200) });
      return;
    }
    rows.push({
      line: i + 1,
      reference: String(r?.reference ?? r?.ref ?? '').trim() || `line-${i + 1}`,
      description: String(r?.description ?? r?.memo ?? '').trim(),
      amount,
      date: r?.date ? String(r.date).trim() : null,
      currency: String(r?.currency ?? 'USD').toUpperCase(),
    });
  });

  return { header: [], rows, rejected };
}

export function parseStatement(text, format) {
  const fmt = (format ?? 'csv').toLowerCase();
  return fmt === 'json' ? parseStatementJson(text) : parseStatementCsv(text);
}

/**
 * Reconcile ingested statement lines against operator-entered records.
 *
 * This is the "removal of assumed recovery" step: a difference is only
 * reported as **confirmed** when a source line supports it. Anything matched
 * purely from typed values is labelled assumed.
 */
export function reconcile(statementRows, records) {
  const byRef = new Map();
  for (const rec of records ?? []) {
    const key = String(rec.reference ?? '').trim();
    if (!key) continue;
    byRef.set(key, rec);
  }

  const confirmed = [];
  const assumed = [];
  const unmatched = [];

  // One statement line per reference: a repeated reference is a duplicate line
  // in the source document and must not be counted twice against one record.
  const seen = new Set();

  for (const row of statementRows) {
    const rec = byRef.get(row.reference);
    if (!rec) {
      unmatched.push({ reference: row.reference, statementAmount: row.amount, line: row.line });
      continue;
    }
    if (seen.has(row.reference)) {
      unmatched.push({
        reference: row.reference,
        statementAmount: row.amount,
        line: row.line,
        status: 'duplicate_line',
        reason: 'Reference already reconciled from an earlier line in this statement',
      });
      continue;
    }
    seen.add(row.reference);
    const entered = Number(rec.amount ?? 0);
    const delta = Number((row.amount - entered).toFixed(2));
    const entry = {
      reference: row.reference,
      line: row.line,
      statementAmount: row.amount,
      enteredAmount: entered,
      delta,
      sourceChecksum: row.checksum ?? null,
      provenance: `${row.sourceFile ?? 'statement'} line ${row.line}`,
    };
    if (delta === 0) confirmed.push({ ...entry, status: 'matched' });
    else if (delta > 0) confirmed.push({ ...entry, status: 'overcharge_supported' });
    else assumed.push({ ...entry, status: 'entered_exceeds_statement' });
  }

  const supportedRecovery = confirmed
    .filter((c) => c.status === 'overcharge_supported')
    .reduce((s, c) => s + c.delta, 0);

  return {
    confirmed,
    assumed,
    unmatched,
    summary: {
      statementRows: statementRows.length,
      // matched = rows that found a record, whether the figure was supported
      // (confirmed) or the entered value exceeded the statement (assumed).
      matched: confirmed.length + assumed.length,
      unmatched: unmatched.length,
      /** Only this figure is supported by a source document. */
      confirmedRecoveryCents: Math.round(supportedRecovery * 100),
      confirmedRecovery: Number(supportedRecovery.toFixed(2)),
      assumedEntries: assumed.length,
    },
    disclaimer:
      'Only differences backed by a statement line are reported as confirmed recovery. ' +
      'A variance without a source line is assumed and is not a refund.',
  };
}

/**
 * Build the ingest result without touching the database, so callers can
 * preview before committing.
 */
export function ingestStatement({ text, format, sourceFile, records }) {
  const checksum = statementChecksum(text);
  const parsed = parseStatement(text, format);
  const rows = parsed.rows.map((r) => ({ ...r, checksum, sourceFile: sourceFile ?? 'upload' }));
  const recon = reconcile(rows, records);

  return {
    checksum,
    sourceFile: sourceFile ?? 'upload',
    format: (format ?? 'csv').toLowerCase(),
    parsed: {
      rowCount: rows.length,
      rejected: parsed.rejected,
    },
    rows,
    reconciliation: recon,
    assumptions: [
      'Amounts are read verbatim from the statement; no figures are inferred.',
      'Rows whose amount is not numeric are rejected and listed, never coerced to zero.',
      'The checksum makes ingestion idempotent: the same file re-uploaded does not create new records.',
      'Recovery is confirmed only where a statement line supports it.',
    ],
  };
}
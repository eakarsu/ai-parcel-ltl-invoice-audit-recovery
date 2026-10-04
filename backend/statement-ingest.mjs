/**
 * Statement ingestion + rule-based recovery reconciliation.
 *
 * Closes the launch condition shared by the recovery apps: *"real statement
 * ingestion and removal of assumed recovery"*. A statement line is the actual
 * (billed/charged/reimbursed) figure from the source document; the expected
 * figure comes from the capability's configured recovery rule. Nothing is
 * confirmed from a typed amount alone.
 *
 * What this adds:
 *   - parse an uploaded statement (CSV or JSON rows) into records
 *   - stamp every row with provenance: source filename, row number, content
 *     checksum — so a figure can always be traced to the line it came from
 *   - idempotent on the statement checksum: re-uploading a file cannot
 *     double-count
 *   - reconcile ingested rows against the configured recovery rule and report
 *     **confirmed** recovery separately from **assumed** entries, ignoring
 *     seeded `__example` records and classifying credit memos
 *
 * Deterministic: no model calls, no invented figures.
 */
import crypto from 'crypto';
import { expectedFromRule } from './recovery-domain.mjs';

/** Stable checksum of the statement content, used as the idempotency key. */
export function statementChecksum(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const validMoneyAmount = value => Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;

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
  const chargeTypeI = idx('charge_type');
  const freightI = idx('base_freight_amount');

  const rows = [];
  const rejected = [];

  for (let n = 1; n < lines.length; n++) {
    const cells = split(lines[n]);
    const rawAmount = (cells[amtI] ?? '').replace(/[$,]/g, '');
    const amount = Number(rawAmount);
    const baseFreightAmount = freightI >= 0 ? String(cells[freightI] ?? '').replace(/[$,]/g, '').trim() : '';

    const badAmount = !/^-?\d+(?:\.\d{1,2})?$/.test(rawAmount.trim()) || !validMoneyAmount(amount);
    const badFreight = baseFreightAmount && (!/^\d+(?:\.\d{1,2})?$/.test(baseFreightAmount) || !validMoneyAmount(Number(baseFreightAmount)));
    if (badAmount || badFreight) {
      rejected.push({
        line: n + 1,
        reason: badAmount ? `amount "${cells[amtI] ?? ''}" is not a number` : 'base_freight_amount is not a valid cent amount',
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
      chargeType: chargeTypeI >= 0 ? String(cells[chargeTypeI] ?? '').trim() : null,
      baseFreightAmount: baseFreightAmount || null,
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
    const rawAmount = r?.amount ?? r?.charge;
    const amount = Number(rawAmount);
    const freight = r?.baseFreightAmount ?? r?.base_freight_amount;
    const badAmount = rawAmount === undefined || rawAmount === null || !/^-?\d+(?:\.\d{1,2})?$/.test(String(rawAmount).trim()) || !validMoneyAmount(amount);
    const badFreight = freight !== undefined && freight !== null && String(freight).trim() !== '' &&
      (!/^\d+(?:\.\d{1,2})?$/.test(String(freight).trim()) || !validMoneyAmount(Number(freight)));
    if (badAmount || badFreight) {
      rejected.push({ line: i + 1, reason: badAmount ? `amount "${r?.amount ?? ''}" is not a number` : 'baseFreightAmount is not a valid cent amount', raw: JSON.stringify(r).slice(0, 200) });
      return;
    }
    rows.push({
      line: i + 1,
      reference: String(r?.reference ?? r?.ref ?? '').trim() || `line-${i + 1}`,
      description: String(r?.description ?? r?.memo ?? '').trim(),
      amount,
      date: r?.date ? String(r.date).trim() : null,
      currency: String(r?.currency ?? 'USD').toUpperCase(),
      chargeType: String(r?.chargeType ?? r?.charge_type ?? '').trim() || null,
      baseFreightAmount: freight === undefined || freight === null || String(freight).trim() === '' ? null : String(freight).trim(),
    });
  });

  return { header: [], rows, rejected };
}

export function parseStatement(text, format) {
  const fmt = (format ?? 'csv').toLowerCase();
  return fmt === 'json' ? parseStatementJson(text) : parseStatementCsv(text);
}

/**
 * Reconcile ingested statement lines against feature records using the
 * capability's configured recovery rule.
 *
 * The statement line is the actual (billed/charged/reimbursed) amount from the
 * source document. The rule's expected key is the contract/policy-supported
 * amount carried by the record. A recovery is confirmed only when the line
 * supports a positive variance in the configured direction:
 *   - `actual-minus-expected`  → billed/charged exceeds what is supported
 *   - `expected-minus-actual`  → supported amount exceeds what was reimbursed
 *
 * Seeded `__example` records are never reconciled into confirmed totals, and a
 * negative statement amount is classified as a credit line rather than assumed
 * recovery. Entries without a rule or without the expected field stay assumed.
 */
export function reconcile(statementRows, records, rule, allowMultipleLines = false) {
  const byRef = new Map();
  for (const rec of records ?? []) {
    const key = String(rec.reference ?? '').trim();
    if (!key || byRef.has(key)) continue;
    byRef.set(key, rec);
  }

  const confirmed = [];
  const matched = [];
  const assumed = [];
  const credits = [];
  const noRecovery = [];
  const ignored = [];
  const unmatched = [];

  // One statement line per reference: a repeated reference is a duplicate line
  // in the source document and must not be counted twice against one record.
  const seen = new Set();

  for (const row of statementRows) {
    const entry = {
      reference: row.reference,
      line: row.line,
      statementAmount: row.amount,
      sourceChecksum: row.checksum ?? null,
      provenance: `${row.sourceFile ?? 'statement'} line ${row.line}`,
    };

    const rec = byRef.get(row.reference);
    if (!rec) {
      unmatched.push({ ...entry, status: 'unmatched', reason: 'No record in this workspace matches the statement reference' });
      continue;
    }
    if (row.amount < 0) {
      credits.push({ ...entry, status: 'credit_line', recordReference: rec.reference, reason: 'Negative statement amount is a credit memo, not a recovery' });
      continue;
    }
    if (!allowMultipleLines && seen.has(row.reference)) {
      unmatched.push({ ...entry, status: 'duplicate_line', reason: 'Reference already reconciled from an earlier line in this statement' });
      continue;
    }
    if (!allowMultipleLines) seen.add(row.reference);

    if (rec.payload?.__example) {
      ignored.push({ ...entry, status: 'seeded_example_ignored', recordReference: rec.reference, reason: 'Seeded example record; it cannot support a source-supported variance' });
      continue;
    }
    if (!rule) {
      assumed.push({ ...entry, status: 'assumed_no_rule', recordReference: rec.reference, reason: 'This capability has no configured recovery rule, so no source-supported recovery can be confirmed' });
      continue;
    }

    const derived = expectedFromRule(rec, rule, row.date);
    const expected = derived.expected;
    if (!validMoneyAmount(expected)) {
      assumed.push({
        ...entry,
        status: 'assumed_missing_expected_amount',
        recordReference: rec.reference,
        expectedKey: rule.expectedKey,
        reason: `${derived.reason}; variance stays assumed`,
      });
      continue;
    }

    const signed = Number((rule.direction === 'expected-minus-actual' ? expected - row.amount : row.amount - expected).toFixed(2));
    const assessed = {
      ...entry,
      recordReference: rec.reference,
      expectedKey: rule.expectedKey,
      expectedAmount: expected,
      signedRecovery: signed,
      rule: { actualKey: rule.actualKey, expectedKey: rule.expectedKey, direction: rule.direction, ...(derived.reference ? { contractReference: derived.reference, formula: derived.formula, effective: derived.effective, expires: derived.expires } : {}) },
    };

    if (signed > 0) confirmed.push({ ...assessed, status: 'recovery_supported' });
    else if (signed === 0) matched.push({ ...assessed, status: 'matched' });
    else noRecovery.push({ ...assessed, status: 'no_recovery_supported', reason: 'The statement line supports no recovery in the configured direction' });
  }

  const confirmedRecovery = confirmed.reduce((sum, item) => sum + item.signedRecovery, 0);
  const creditTotal = credits.reduce((sum, item) => sum + item.statementAmount, 0);

  return {
    confirmed,
    matched,
    assumed,
    credits,
    noRecovery,
    ignored,
    unmatched,
    rule: rule ?? null,
    summary: {
      statementRows: statementRows.length,
      matched: confirmed.length + matched.length + assumed.length + credits.length + noRecovery.length + ignored.length,
      unmatched: unmatched.length,
      confirmedEntries: confirmed.length,
      /** Only this figure is supported by a source line and the configured rule. */
      confirmedRecoveryCents: Math.round(confirmedRecovery * 100),
      confirmedRecovery: Number(confirmedRecovery.toFixed(2)),
      assumedEntries: assumed.length,
      ignoredExamples: ignored.length,
      creditEntries: credits.length,
      creditTotal: Number(creditTotal.toFixed(2)),
      noRecoveryEntries: noRecovery.length,
    },
    disclaimer:
      'Positive variances supported by an ingested statement line and the configured recovery rule are candidates for review, not proof of a received refund. ' +
      'Typed values, seeded examples, and credit memos never establish a paid recovery.',
  };
}

/**
 * Build the ingest result without touching the database, so callers can
 * preview and persist exactly the same figures.
 */
export function ingestStatement({ text, format, sourceFile, records, rule, allowMultipleLines = false }) {
  const checksum = statementChecksum(text);
  const parsed = parseStatement(text, format);
  const rows = parsed.rows.map((r) => ({ ...r, checksum, sourceFile: sourceFile ?? 'upload' }));
  const recon = reconcile(rows, records, rule, allowMultipleLines);

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
      'A positive variance is reported only where a statement line and the configured recovery rule support it; this is not proof of payment.',
      'Seeded example records and negative credit lines never become a positive candidate variance.',
    ],
  };
}

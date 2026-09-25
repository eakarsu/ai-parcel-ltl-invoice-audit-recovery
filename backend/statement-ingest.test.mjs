import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestStatement, parseStatementCsv, statementChecksum } from './statement-ingest.mjs';

const CSV = [
  'reference,description,amount',
  'INV-001,Detention fee,125.50',
  'INV-002,Liftgate charge,80.00',
  'INV-003,Bad row,not-a-number',
  'INV-001,Detention fee,125.50',
].join('\n');

test('parses rows and rejects non-numeric amounts instead of coercing to zero', () => {
  const { rows, rejected } = parseStatementCsv(CSV);
  assert.equal(rows.length, 3);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /is not a number/);
  assert.equal(rows[0].amount, 125.5);
});

test('ingestion is idempotent on checksum', () => {
  const a = ingestStatement({ text: CSV, records: [] });
  const b = ingestStatement({ text: CSV, records: [] });
  assert.equal(a.checksum, b.checksum);
  assert.equal(statementChecksum(CSV), a.checksum);
});

test('recovery is confirmed only where a statement line supports it', () => {
  const records = [
    { reference: 'INV-001', amount: 100.0 },   // statement says 125.50 -> supported +25.50
    { reference: 'INV-002', amount: 95.0 },    // statement says 80.00 -> entered exceeds, assumed
  ];
  const out = ingestStatement({ text: CSV, sourceFile: 'parcel-oct.csv', records });
  const { summary, confirmed, assumed, unmatched } = out.reconciliation;

  assert.equal(summary.matched, 2);
  assert.equal(summary.unmatched, 1);                 // INV-001 duplicate line 4 has no 4th record
  assert.equal(summary.confirmedRecovery, 25.5);      // only the supported overcharge
  assert.equal(summary.assumedEntries, 1);
  assert.equal(confirmed.find(c => c.reference === 'INV-001').status, 'overcharge_supported');
  assert.equal(assumed[0].status, 'entered_exceeds_statement');
  assert.match(confirmed[0].provenance, /parcel-oct\.csv line 2/);
  assert.ok(out.reconciliation.disclaimer.includes('not a refund'));
});

test('zero-variance rows are matched, not reported as recovery', () => {
  const out = ingestStatement({
    text: 'reference,description,amount\nA,x,50\n',
    records: [{ reference: 'A', amount: 50 }],
  });
  assert.equal(out.reconciliation.summary.confirmedRecovery, 0);
  assert.equal(out.reconciliation.confirmed[0].status, 'matched');
});

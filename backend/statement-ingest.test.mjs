import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../app.config.mjs';
import { recoveryRuleFor } from './recovery-domain.mjs';
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

// The rule differs per app (marketplace reconciles expected-minus-actual), so
// this shared suite derives it from app.config.mjs instead of hard-coding keys.
const ruleFeature = config.features.find((feature) => recoveryRuleFor(config, feature));
const rule = recoveryRuleFor(config, ruleFeature);
const recoveryLine = rule.direction === 'expected-minus-actual' ? 80 : 125.5;
const shortfallLine = rule.direction === 'expected-minus-actual' ? 130 : 70;

test('confirms recovery only through the configured rule, and never from seeded examples or credits', () => {
  const text = [
    'reference,description,amount',
    `INV-001,primary evidence,${recoveryLine}`,
    `INV-002,secondary evidence,${shortfallLine}`,
    `INV-003,seeded example,${recoveryLine}`,
    'INV-004,credit memo,-15.00',
    `INV-001,duplicate line,${recoveryLine}`,
  ].join('\n');
  const records = [
    { reference: 'INV-001', amount: 100, payload: { [rule.expectedKey]: 100 } },
    { reference: 'INV-002', amount: 100, payload: { [rule.expectedKey]: 100 } },
    { reference: 'INV-003', amount: 100, payload: { [rule.expectedKey]: 100, __example: true } },
    { reference: 'INV-004', amount: 100, payload: { [rule.expectedKey]: 100 } },
  ];
  const { reconciliation } = ingestStatement({ text, sourceFile: 'shared-domain.csv', records, rule });
  const { summary, confirmed, ignored, credits, noRecovery, assumed, unmatched } = reconciliation;
  const supported = rule.direction === 'expected-minus-actual' ? 20 : 25.5;

  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].status, 'recovery_supported');
  assert.equal(confirmed[0].recordReference, 'INV-001');
  assert.equal(confirmed[0].signedRecovery, supported);
  assert.equal(summary.confirmedRecovery, supported);
  assert.match(confirmed[0].provenance, /shared-domain\.csv line 2/);

  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].status, 'seeded_example_ignored');
  assert.equal(summary.ignoredExamples, 1);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].status, 'credit_line');
  assert.equal(summary.creditTotal, -15);
  assert.equal(noRecovery.length, 1);
  assert.equal(noRecovery[0].status, 'no_recovery_supported');
  assert.equal(assumed.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].status, 'duplicate_line');
  assert.equal(summary.matched, 4);
  assert.ok(reconciliation.disclaimer.includes('never become confirmed refunds'));
});

test('records without the expected amount or without a rule stay assumed', () => {
  const missing = ingestStatement({
    text: `reference,description,amount\nINV-001,x,${recoveryLine}\n`,
    sourceFile: 'missing.csv',
    records: [{ reference: 'INV-001', amount: 100, payload: {} }],
    rule,
  });
  assert.equal(missing.reconciliation.confirmed.length, 0);
  assert.equal(missing.reconciliation.assumed[0].status, 'assumed_missing_expected_amount');

  const noRuleFeature = config.features.find((feature) => !recoveryRuleFor(config, feature));
  if (noRuleFeature) {
    const noRule = ingestStatement({
      text: 'reference,description,amount\nINV-001,x,10\n',
      sourceFile: 'norule.csv',
      records: [{ reference: 'INV-001', amount: 5, payload: {} }],
      rule: null,
    });
    assert.equal(noRule.reconciliation.confirmed.length, 0);
    assert.equal(noRule.reconciliation.assumed[0].status, 'assumed_no_rule');
  }
});

test('zero-variance rows are matched, not reported as recovery', () => {
  const out = ingestStatement({
    text: 'reference,description,amount\nA,x,100\n',
    records: [{ reference: 'A', amount: 100, payload: { [rule.expectedKey]: 100 } }],
    rule,
  });
  assert.equal(out.reconciliation.summary.confirmedRecovery, 0);
  assert.equal(out.reconciliation.matched[0].status, 'matched');
});

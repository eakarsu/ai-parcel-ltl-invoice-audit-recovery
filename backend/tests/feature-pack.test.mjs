import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

const { filterRecords, recordsToCsv, buildInsights } = await import('../feature-pack.mjs');

const config = { calculation: { actualKey: 'billedAmount', expectedKey: 'supportedAmount', direction: 'actual-minus-expected' } };
const feature = { id: 'base-rate-recalculation', title: 'Base-rate recalculation' };
const records = [
  { reference: 'FIR-1', title: 'Alpha, "quoted" case', status: 'Open', owner: 'Sam', risk: 'High', due_date: '2020-01-01', amount: 0, payload: { billedAmount: 220, supportedAmount: 160 } },
  { reference: 'FIR-2', title: 'Beta case', status: 'Closed', owner: '', risk: 'Low', due_date: '2999-01-01', amount: 50, payload: { billedAmount: 200, supportedAmount: 200 } },
];

test('filterRecords searches and filters the main list', () => {
  assert.equal(filterRecords(records, { q: 'alpha' }).length, 1);
  assert.equal(filterRecords(records, { status: 'Closed' }).length, 1);
  assert.equal(filterRecords(records, { risk: 'High' }).length, 1);
  assert.equal(filterRecords(records, { q: 'missing' }).length, 0);
});

test('recordsToCsv preserves 0, quoted text, and empty owner', () => {
  const csv = recordsToCsv(records, config);
  assert.match(csv, /FIR-1,"Alpha, ""quoted"" case",Open,Sam,High,2020-01-01,0,60/);
  assert.match(csv, /FIR-2,Beta case,Closed,,Low,2999-01-01,50,0/);
});

test('buildInsights is a labelled deterministic fallback over own records', () => {
  const out = buildInsights(config, feature, records);
  assert.equal(out.aiGenerated, false);
  assert.equal(out.insights.length, 3);
  assert.ok(out.insights.every((i) => i.aiGenerated === false));
  const variance = out.insights[0];
  assert.equal(variance.metrics.find((m) => m.label === 'Records reviewed').value, 2);
  assert.equal(variance.metrics.find((m) => m.label === 'Total variance').value, 60);
  assert.equal(variance.metrics.find((m) => m.label === 'Any overdue').value, true);
  const empty = buildInsights(config, feature, []);
  assert.equal(empty.insights[0].metrics.find((m) => m.label === 'Records reviewed').value, 0);
  assert.equal(empty.insights[0].metrics.find((m) => m.label === 'Any overdue').value, false);
});

test('feature pack routes and workbench controls are mounted', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('mountFeaturePack('), 'server must mount the feature pack');
  const workbench = fs.readFileSync(new URL('../../frontend/src/RecoveryWorkbench.jsx', import.meta.url), 'utf8');
  assert.ok(workbench.includes('Search records'), 'workbench must offer search');
  assert.ok(workbench.includes('Export CSV'), 'workbench must offer CSV export');
  assert.ok(workbench.includes('Deterministic fallback'), 'insights must be labelled as fallback');
});

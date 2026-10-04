import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCreditEvidence } from './claim-routes.mjs';
import config from '../app.config.mjs';
import { calculate, recoveryRuleFor } from './recovery-domain.mjs';
import { ingestStatement } from './statement-ingest.mjs';

test('a later imported credit must belong to the same customer, case, feature and currency', () => {
  const claim = { account_id: 'customer-a', feature_id: 'invoice-audit', record_reference: 'CASE-1', requested_cents: 2500, credit_cents: 0 };
  const source = { account_id: 'customer-a', feature_id: 'invoice-audit', record_reference: 'CASE-1', ingest_id: 1, reconciliation_status: 'recovery_supported', currency: 'USD' };
  const credit = { account_id: 'customer-a', feature_id: 'invoice-audit', record_reference: 'CASE-1', ingest_id: 2, reconciliation_status: 'credit_line', amount: '-25.00', currency: 'USD' };
  assert.equal(validateCreditEvidence(claim, source, credit), 2500);
  assert.throws(() => validateCreditEvidence(claim, source, { ...credit, account_id: 'customer-b' }), /same customer/);
  assert.throws(() => validateCreditEvidence(claim, source, { ...credit, ingest_id: 1 }), /later imported/);
  assert.throws(() => validateCreditEvidence(claim, source, { ...credit, amount: '-26.00' }), /exceeds/);
});

test('fuel surcharge derives expected cents from dated contract terms, not a typed supported amount', () => {
  const feature = config.features.find(row => row.id === 'fuel-surcharge-audit');
  const rule = recoveryRuleFor(config, feature);
  const payload = { carrier: 'Carrier', trackingNumber: 'TRACK-1', billedAmount: 15.30, contractReference: 'RATECARD-2026-Q3', baseFreightAmount: 100,
    contractFuelPercent: 12.5, contractEffectiveDate: '2026-01-01', contractExpiresDate: '2026-12-31', chargeDate: '2026-07-18' };
  const result = calculate(config, feature, payload);
  assert.equal(result.expectedCents, 1250);
  assert.equal(result.signedVarianceCents, 280);
  const supported = ingestStatement({ text: 'reference,description,amount,date\nCASE-1,Fuel surcharge,15.30,2026-07-18\n', sourceFile: 'carrier.csv', records: [{ reference: 'CASE-1', payload }], rule });
  assert.equal(supported.reconciliation.confirmed[0].signedRecovery, 2.8);
  assert.equal(supported.reconciliation.confirmed[0].rule.contractReference, 'RATECARD-2026-Q3');
  const outside = ingestStatement({ text: 'reference,description,amount,date\nCASE-1,Fuel surcharge,15.30,2027-01-01\n', records: [{ reference: 'CASE-1', payload }], rule });
  assert.equal(outside.reconciliation.confirmed.length, 0);
  assert.equal(outside.reconciliation.assumed.length, 1);
});

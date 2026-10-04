import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSurcharge, percentUnits, tariffDate } from './tariff-engine.mjs';

const fuel = {
  id: 3, version: 2, method: 'PERCENT_OF_BASE', percent_units: percentUnits('12.5'), fixed_cents: null,
  charge_type_key: 'fuel surcharge', carrier_key: 'northstar parcel', effective_on: new Date('2026-01-01'), expires_on: new Date('2026-12-31'),
};
const invoice = {
  amount: '15.30', currency: 'USD', statement_date: '2026-07-18', checksum: 'invoice-hash', line_number: 2,
  provenance: { chargeType: 'Fuel surcharge', baseFreightAmount: '100.00' },
};

test('fuel surcharge compares exact imported cents with an approved dated percent', () => {
  const result = assessSurcharge(fuel, invoice);
  assert.equal(result.status, 'CANDIDATE');
  assert.equal(result.observedCents, 1530);
  assert.equal(result.expectedCents, 1250);
  assert.equal(result.varianceCents, 280);
  assert.equal(result.calculation.statementChecksum, 'invoice-hash');
  assert.equal(result.calculation.ruleVersion, 2);
});

test('percent rounding happens at one cent after multiplying imported base cents', () => {
  const result = assessSurcharge({ ...fuel, percent_units: percentUnits('12.3456') },
    { ...invoice, amount: '0.21', provenance: { ...invoice.provenance, baseFreightAmount: '1.25' } });
  assert.equal(result.expectedCents, 15);
  assert.equal(result.varianceCents, 6);
});

test('fixed per-shipment accessorial and insufficient fuel basis are distinct', () => {
  const fixed = assessSurcharge({ ...fuel, method: 'FIXED_PER_SHIPMENT', percent_units: null, fixed_cents: 500,
    charge_type_key: 'residential surcharge' }, { ...invoice, amount: '7.00', provenance: { chargeType: 'Residential surcharge' } });
  assert.equal(fixed.status, 'CANDIDATE');
  assert.equal(fixed.expectedCents, 500);
  assert.equal(fixed.varianceCents, 200);
  const missing = assessSurcharge(fuel, { ...invoice, provenance: { chargeType: 'Fuel surcharge' } });
  assert.equal(missing.status, 'INSUFFICIENT');
  assert.equal(missing.varianceCents, null);
  assert.equal(assessSurcharge(fuel, { ...invoice, currency: 'EUR' }).status, 'INSUFFICIENT');
});

test('bad dates, charge types, and percent precision cannot create candidate assessments', () => {
  assert.equal(tariffDate('2026-07-18', 'Date'), '2026-07-18');
  assert.throws(() => tariffDate('2026-02-30', 'Date'));
  assert.throws(() => percentUnits('12.34567'));
  assert.throws(() => assessSurcharge(fuel, { ...invoice, statement_date: '2027-01-01' }));
  assert.throws(() => assessSurcharge(fuel, { ...invoice, provenance: { ...invoice.provenance, chargeType: 'Delivery' } }));
});

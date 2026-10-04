import { amount, invalid } from './recovery-domain.mjs';

export const tariffKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isoDay = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
export function tariffDate(value, label) {
  const text = String(value ?? '');
  if (!validDay(text)) throw invalid(`${label} must be a valid YYYY-MM-DD date`);
  return text;
}
export function percentUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(text) || Number(text) > 100)
    throw invalid('Fuel percentage must be 0–100 with at most four decimal places');
  const [whole, fraction = ''] = text.split('.');
  return Number(BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')));
}

export function assessSurcharge(rule, line) {
  if (tariffKey(line.provenance?.chargeType) !== rule.charge_type_key)
    throw invalid('Invoice charge type does not match the approved tariff rule', 409);
  const date = isoDay(line.statement_date);
  if (!validDay(date) || date < isoDay(rule.effective_on) || date > isoDay(rule.expires_on))
    throw invalid('Invoice line is outside the approved tariff date window', 409);
  if (Number(line.amount) < 0) throw invalid('A carrier credit is not a positive surcharge exception', 409);
  const observedCents = amount(line.amount, 'Carrier surcharge');
  if (line.currency !== 'USD') return { observedCents, expectedCents: null, varianceCents: null, status: 'INSUFFICIENT',
    calculation: { reason: 'Tariff assessment currently supports USD invoice lines only', ruleId: rule.id, ruleVersion: rule.version } };
  let expectedCents, basisCents = null;
  if (rule.method === 'PERCENT_OF_BASE') {
    const raw = line.provenance?.baseFreightAmount;
    if (raw === undefined || raw === null || String(raw).trim() === '')
      return { observedCents, expectedCents: null, varianceCents: null, status: 'INSUFFICIENT',
        calculation: { reason: 'Imported base freight amount is missing', ruleId: rule.id, ruleVersion: rule.version } };
    basisCents = amount(raw, 'Imported base freight amount');
    expectedCents = Number((BigInt(basisCents) * BigInt(rule.percent_units) + 500000n) / 1000000n);
  } else if (rule.method === 'FIXED_PER_SHIPMENT') expectedCents = Number(rule.fixed_cents);
  else throw invalid('Unsupported tariff method', 409);
  if (!Number.isSafeInteger(expectedCents)) throw invalid('Calculated surcharge exceeds supported precision');
  const varianceCents = observedCents - expectedCents;
  return { observedCents, expectedCents, varianceCents,
    status: varianceCents > 0 ? 'CANDIDATE' : 'NO_VARIANCE',
    calculation: { method: rule.method, ruleId: rule.id, ruleVersion: rule.version,
      carrier: rule.carrier_key, chargeType: rule.charge_type_key, statementChecksum: line.checksum,
      statementLine: line.line_number, invoiceDate: date, basisCents, percentUnits: rule.percent_units,
      fixedCents: rule.fixed_cents, observedCents, expectedCents, signedVarianceCents: varianceCents,
      scope: 'Candidate exception from an imported carrier invoice and independently approved operator-supplied tariff line; source authenticity, carrier acceptance and paid credit are unverified' },
  };
}

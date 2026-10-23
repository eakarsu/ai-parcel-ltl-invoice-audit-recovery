// Feature pack: search/filter helpers, CSV/JSON export, and deterministic
// domain insights over the app's own records. Never calls an AI provider;
// every insight is labelled aiGenerated:false with a deterministic fallback.
const DOMAIN = {
  varianceTitle: 'Overcharge variance hotspots',
  flagsTitle: 'Duplicate and guarantee risk flags',
  priorityTitle: 'Recovery priority ranking',
  varianceNoun: 'freight overcharge',
  disclaimer: 'Informational only. Validate the carrier agreement, tariff, and shipment evidence before disputing any charge.',
};

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function text(value) { return value == null ? '' : String(value); }

export function filterRecords(items, { q = '', status = '', risk = '' } = {}) {
  const needle = text(q).trim().toLowerCase();
  return (items || []).filter((item) => {
    if (status && item.status !== status) return false;
    if (risk && item.risk !== risk) return false;
    if (!needle) return true;
    const hay = [item.reference, item.title, item.status, item.owner, item.risk, text(item.due_date)].join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

export function recordVariance(record, config) {
  const rule = config?.calculation;
  const payload = record?.payload || {};
  if (rule?.actualKey && rule?.expectedKey && payload[rule.actualKey] != null && payload[rule.expectedKey] != null) {
    const actual = num(payload[rule.actualKey]); const expected = num(payload[rule.expectedKey]);
    return Math.max(0, rule.direction === 'expected-minus-actual' ? expected - actual : actual - expected);
  }
  return num(record?.amount);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recordsToCsv(items, config) {
  const header = ['reference', 'title', 'status', 'owner', 'risk', 'due_date', 'amount', 'variance'];
  const lines = (items || []).map((item) => [item.reference, item.title, item.status, item.owner, item.risk, text(item.due_date).slice(0, 10), num(item.amount), recordVariance(item, config)].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

export function buildInsights(config, feature, records) {
  const rows = records || [];
  const enriched = rows.map((r) => ({ reference: r.reference, title: r.title, status: r.status, owner: r.owner, risk: r.risk, due_date: r.due_date, amount: num(r.amount), variance: recordVariance(r, config), evidence: r.payload?.evidenceState ?? '', payload: r.payload || {} }));
  const totalVariance = enriched.reduce((s, r) => s + r.variance, 0);
  const highRisk = enriched.filter((r) => ['High', 'Critical'].includes(r.risk));
  const overdue = enriched.filter((r) => r.due_date && text(r.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10) && !['Approved', 'Closed'].includes(r.status));
  const byVariance = [...enriched].sort((a, b) => b.variance - a.variance);
  const seen = new Set(); const duplicates = [];
  for (const r of enriched) { if (seen.has(r.reference)) duplicates.push(r); seen.add(r.reference); }
  const weakEvidence = enriched.filter((r) => ['Incomplete', 'Exception'].includes(r.evidence));
  const flags = [
    ...duplicates.map((r) => ({ reference: r.reference, reason: 'Duplicate reference in this register', amount: r.amount, variance: r.variance })),
    ...weakEvidence.map((r) => ({ reference: r.reference, reason: `Evidence state is ${r.evidence || 'not recorded'}`, amount: r.amount, variance: r.variance })),
    ...overdue.map((r) => ({ reference: r.reference, reason: 'Open past its due date', amount: r.amount, variance: r.variance })),
  ];
  const base = { aiGenerated: false, source: 'deterministic-fallback', label: 'Deterministic fallback (no AI provider call)' };
  return {
    featureId: feature.id, ...base, disclaimer: DOMAIN.disclaimer,
    insights: [
      { id: 'variance-hotspots', title: DOMAIN.varianceTitle, ...base,
        summary: `${rows.length} record(s) carry ${totalVariance.toFixed(2)} of ${DOMAIN.varianceNoun} under the configured billed-vs-supported rule.`,
        metrics: [
          { label: 'Records reviewed', value: rows.length },
          { label: 'Total variance', value: Number(totalVariance.toFixed(2)) },
          { label: 'Largest single variance', value: byVariance.length ? Number(byVariance[0].variance.toFixed(2)) : 0 },
          { label: 'High-risk records', value: highRisk.length },
          { label: 'Any overdue', value: overdue.length > 0 },
        ],
        sections: [
          { title: 'What was checked', detail: 'Each record in this register was compared with the configured billed-vs-supported freight rule. No external provider was called.' },
          { title: 'Largest exceptions', detail: byVariance.slice(0, 3).map((r) => `${r.reference}: ${r.variance.toFixed(2)}`).join('; ') || 'None reported.' },
          { title: 'Next step', detail: 'Open the largest exception, re-rate it against the effective tariff, then assign an owner.' },
        ] },
      { id: 'duplicate-risk-flags', title: DOMAIN.flagsTitle, ...base,
        summary: flags.length ? `${flags.length} record(s) need evidence or follow-up review.` : 'No duplicate, weak-evidence, or overdue records were found.',
        metrics: [
          { label: 'Flagged records', value: flags.length },
          { label: 'Duplicate references', value: duplicates.length },
          { label: 'Incomplete or exception evidence', value: weakEvidence.length },
          { label: 'Overdue open records', value: overdue.length },
        ],
        sections: [
          { title: 'Flags', detail: flags.slice(0, 5).map((f) => `${f.reference} — ${f.reason}`).join('; ') || 'None reported.' },
          { title: 'Next step', detail: 'Clear evidence gaps first, then re-run the recalculation for flagged records.' },
        ], flags },
      { id: 'recovery-priority', title: DOMAIN.priorityTitle, ...base,
        summary: byVariance.length ? `Start with ${byVariance[0].reference} (${byVariance[0].variance.toFixed(2)}).` : 'No records to rank yet.',
        metrics: [
          { label: 'Ranked records', value: byVariance.length },
          { label: 'Closed records', value: enriched.filter((r) => r.status === 'Closed').length },
          { label: 'Open records', value: enriched.filter((r) => r.status === 'Open').length },
        ],
        sections: [
          { title: 'Priority order', detail: byVariance.slice(0, 5).map((r, i) => `${i + 1}. ${r.reference} — ${r.variance.toFixed(2)} (${r.status})`).join('; ') || 'None reported.' },
          { title: 'Next step', detail: 'Work the ranking top-down and record each disposition in the audit trail.' },
        ] },
    ],
  };
}

export function mountFeaturePack(app, { pool, auth, featureById, accountScoped = false, config }) {
  const scope = accountScoped ? ' AND account_id=$2' : '';
  const args = (req) => [req.params.id, ...(accountScoped ? [req.user.account_id] : [])];
  app.get('/api/features/:id/records/export', auth, async (req, res, next) => {
    try {
      const feature = featureById(req.params.id);
      const rows = (await pool.query(`SELECT * FROM feature_records WHERE feature_id=$1${scope} ORDER BY updated_at DESC,id DESC`, args(req))).rows;
      const items = filterRecords(rows, req.query);
      if (String(req.query.format || 'json').toLowerCase() === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${feature.id}-records.csv"`);
        return res.send(recordsToCsv(items, config));
      }
      return res.json({ featureId: feature.id, count: items.length, items });
    } catch (error) { return next(error); }
  });
  app.get('/api/features/:id/insights', auth, async (req, res, next) => {
    try {
      const feature = featureById(req.params.id);
      const rows = (await pool.query(`SELECT * FROM feature_records WHERE feature_id=$1${scope} ORDER BY updated_at DESC,id DESC`, args(req))).rows;
      return res.json(buildInsights(config, feature, rows));
    } catch (error) { return next(error); }
  });
}

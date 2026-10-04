import React, { useEffect, useState } from 'react';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
const parcelFeatures = [
  { id: 'fuel-surcharge-audit', title: 'Fuel surcharge · percent of imported base freight' },
  { id: 'accessorial-charge-validation', title: 'Accessorial charge · fixed fee per shipment' },
];

export default function TariffRates({ request, notify, user }) {
  const [sources, setSources] = useState([]);
  const [rules, setRules] = useState([]);
  const [cases, setCases] = useState([]);
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState(null);
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ featureId: parcelFeatures[0].id, carrier: '', chargeType: 'Fuel surcharge', rate: '', effectiveOn: '', expiresOn: '', sourceQuote: '' });
  const [selectedRule, setSelectedRule] = useState(null);
  const [assessments, setAssessments] = useState([]);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    const [sourceData, ruleData, caseData] = await Promise.all([
      request('/api/parcel/tariff-sources'), request('/api/parcel/tariff-rules'), request('/api/parcel/cases'),
    ]);
    setSources(sourceData.items || []); setRules(ruleData.items || []); setCases(caseData.items || []);
  }
  useEffect(() => { load().catch(err => setError(err.message)); }, []);
  async function selectSource(value) {
    setSourceId(value); setSource(null);
    if (!value) return;
    try { setSource((await request(`/api/parcel/tariff-sources/${value}`)).source); }
    catch (err) { setError(err.message); }
  }
  async function selectRule(rule) {
    setSelectedRule(rule); setAssessments([]);
    if (!rule) return;
    try { setAssessments((await request(`/api/parcel/tariff-rules/${rule.id}/assessments`)).items || []); }
    catch (err) { setError(err.message); }
  }
  async function act(work) {
    setBusy(true); setError('');
    try { await work(); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const realCases = cases.filter(item => item.feature_id === form.featureId && item.carrier);
  const sourceLines = source?.content?.split(/\r?\n/).map((line, index) => ({ line, number: index + 1 })).filter(item => item.line.trim()) || [];
  const canDraft = ['admin', 'operator'].includes(user.role);
  return <>
    <header className="pageTitle"><div><span className="eyebrow">Customer account {user.account_id}</span><h2>Carrier tariff review</h2><p>Import carrier rate-card text, cite one exact line, and have another person approve its dated rule. Source authenticity, carrier agreement, and any later claim or credit remain unverified.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>1. Import a rate-card or tariff file</h3><p>Accepted local files: CSV or TXT, up to 500 KB. The source is stored with a SHA-256 checksum and the staff member who imported it. This is operator-supplied evidence.</p>
      <form onSubmit={event => { event.preventDefault(); act(async () => {
        if (!file || file.size > 500000) throw new Error('Choose a CSV or TXT file no larger than 500 KB.');
        const data = await request('/api/parcel/tariff-sources', { method: 'POST', body: JSON.stringify({ sourceFile: file.name, content: await file.text() }) });
        notify('Rate-card text imported. Its carrier origin has not been authenticated.');
        await selectSource(String(data.source.id));
      }); }}>
        <label>Rate-card file<input type="file" accept=".csv,.txt,text/csv,text/plain" required onChange={event => setFile(event.target.files?.[0] || null)} /></label>
        <button className="primary" disabled={busy || !canDraft || !file}>Import rate card</button>
      </form>
      <label>Inspect imported source<select value={sourceId} onChange={event => selectSource(event.target.value)}><option value="">Select source</option>{sources.map(item => <option key={item.id} value={item.id}>{item.source_file} · {item.content_hash.slice(0, 12)}…</option>)}</select></label>
      {source && <><p>SHA-256: <code>{source.content_hash}</code>. Select an exact line to cite in a draft rule.</p><div className="tableWrap"><table><thead><tr><th>Line</th><th>Imported text</th><th></th></tr></thead><tbody>{sourceLines.slice(0, 200).map(item => <tr key={item.number}><td>{item.number}</td><td><code>{item.line}</code></td><td><button type="button" className="secondary" onClick={() => setForm(current => ({ ...current, sourceQuote: item.line.trim() }))}>Cite line</button></td></tr>)}</tbody></table></div>{sourceLines.length > 200 && <p>Showing the first 200 lines. You can paste an exact later line into the quote field.</p>}</>}
    </section>
    <section className="panel"><h3>2. Draft a dated surcharge rule</h3><p>Create a real fuel or accessorial case for this carrier first. The cited line must name the carrier, charge type, rate, method, and both effective dates. The fuel rate is a percent of imported base freight; the accessorial rate is dollars per shipment.</p>
      <form onSubmit={event => { event.preventDefault(); act(async () => {
        await request('/api/parcel/tariff-rules', { method: 'POST', body: JSON.stringify({ ...form, sourceId: Number(sourceId) }) });
        notify('Tariff draft saved. Independent approval is required before assessment.');
      }); }}>
        <div className="formGrid"><label>Capability<select value={form.featureId} onChange={event => setForm({ ...form, featureId: event.target.value, carrier: '', chargeType: event.target.value === 'fuel-surcharge-audit' ? 'Fuel surcharge' : 'Residential surcharge' })}>{parcelFeatures.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>Carrier in a real case<select required value={form.carrier} onChange={event => setForm({ ...form, carrier: event.target.value })}><option value="">Select carrier</option>{[...new Set(realCases.map(item => item.carrier))].map(carrier => <option key={carrier}>{carrier}</option>)}</select></label>
        <label>Charge type<input required value={form.chargeType} onChange={event => setForm({ ...form, chargeType: event.target.value })} /></label>
        <label>{form.featureId === 'fuel-surcharge-audit' ? 'Fuel percent' : 'Fixed dollars per shipment'}<input required type="number" min="0" max={form.featureId === 'fuel-surcharge-audit' ? '100' : undefined} step={form.featureId === 'fuel-surcharge-audit' ? '0.0001' : '0.01'} value={form.rate} onChange={event => setForm({ ...form, rate: event.target.value })} /></label>
        <label>Effective on<input required type="date" value={form.effectiveOn} onChange={event => setForm({ ...form, effectiveOn: event.target.value })} /></label>
        <label>Expires on<input required type="date" value={form.expiresOn} onChange={event => setForm({ ...form, expiresOn: event.target.value })} /></label></div>
        <label>Exact cited source line<textarea required minLength={20} value={form.sourceQuote} onChange={event => setForm({ ...form, sourceQuote: event.target.value })} /></label>
        <button className="primary" disabled={busy || !canDraft || !sourceId}>Save draft version</button>
      </form>
    </section>
    <section className="panel"><h3>3. Review and assess imported invoice lines</h3><p>Approval requires a different administrator or reviewer. Each approved version supersedes the prior version for the same carrier and charge type. The assessment only compares exact imported charge types and dates.</p>
      {rules.length ? <div className="tableWrap"><table><thead><tr><th>Carrier / charge</th><th>Rule</th><th>Dates</th><th>Source</th><th>Review</th><th></th></tr></thead><tbody>{rules.map(rule => <tr key={rule.id}><td>{rule.carrier_label}<br />{rule.charge_type_label}</td><td>v{rule.version} · {rule.method === 'PERCENT_OF_BASE' ? `${Number(rule.percent_units) / 10000}% of base freight` : `${money(rule.fixed_cents)} per shipment`}</td><td>{String(rule.effective_on).slice(0, 10)} to {String(rule.expires_on).slice(0, 10)}</td><td>{rule.source_file} #{rule.source_line}<br /><small>SHA-256 {rule.source_hash.slice(0, 12)}…</small></td><td>{rule.status}</td><td><button type="button" className="secondary" onClick={() => selectRule(rule)}>Inspect</button></td></tr>)}</tbody></table></div> : <p>No tariff rules yet.</p>}
      {selectedRule && <div><h4>Rule {selectedRule.id} · version {selectedRule.version}</h4><blockquote>{selectedRule.source_quote}</blockquote><p>Imported source {selectedRule.source_file}, line {selectedRule.source_line}, SHA-256 {selectedRule.source_hash}. This quote is operator supplied and has not been authenticated with the carrier.</p>
        {selectedRule.status === 'DRAFT' && <form onSubmit={event => { event.preventDefault(); act(async () => { await request(`/api/parcel/tariff-rules/${selectedRule.id}/approve`, { method: 'POST', body: JSON.stringify({ rationale }) }); setRationale(''); await selectRule(null); notify('Independent tariff review recorded. Carrier source authenticity remains unverified.'); }); }}><label>Independent review rationale<textarea required minLength={20} maxLength={2000} value={rationale} onChange={event => setRationale(event.target.value)} /></label><button className="primary" disabled={busy || !['admin', 'reviewer'].includes(user.role) || String(selectedRule.created_by_id) === String(user.id)}>Approve cited rule</button></form>}
        {selectedRule.status === 'APPROVED' && <button className="primary" disabled={busy} onClick={() => act(async () => { const result = await request(`/api/parcel/tariff-rules/${selectedRule.id}/assess`, { method: 'POST', body: '{}' }); await selectRule(selectedRule); notify(`${result.newAssessments} imported line assessments saved. Review candidates under Claims.`); })}>Assess imported lines</button>}
        <h4>Immutable assessments</h4>{assessments.length ? <div className="tableWrap"><table><thead><tr><th>Invoice source</th><th>Status</th><th>Billed</th><th>Expected</th><th>Candidate</th><th>Reason</th></tr></thead><tbody>{assessments.map(item => <tr key={item.id}><td>{item.source_file} #{item.line_number}<br /><small>{item.checksum.slice(0, 12)}…</small></td><td>{item.status}</td><td>{money(item.observed_cents)}</td><td>{item.expected_cents == null ? '—' : money(item.expected_cents)}</td><td>{item.variance_cents > 0 ? money(item.variance_cents) : '—'}</td><td>{item.calculation?.reason || 'Deterministic tariff comparison'}</td></tr>)}</tbody></table></div> : <p>No lines assessed for this version.</p>}</div>}
    </section>
  </>;
}

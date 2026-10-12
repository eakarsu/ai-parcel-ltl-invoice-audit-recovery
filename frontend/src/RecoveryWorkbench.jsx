import React, { useEffect, useRef, useState } from 'react';
import { scenario, readableLabel } from './recoveryFields.mjs';
import RecoveryReport from './RecoveryReport.jsx';
import RecoveryRecordDialog, { RecoveryField, RecoveryModal } from './RecoveryRecordDialog.jsx';
import { AIResultValue, reportValue } from './RecoveryReportValue.jsx';
import './RecoveryUI.css';

export default function RecoveryWorkbench({ app, feature, request, notify }) {
  const [values, setValues] = useState(() => scenario(feature)), [items, setItems] = useState([]), [history, setHistory] = useState([]), [result, setResult] = useState(null), [selected, setSelected] = useState(null), [selectedReport, setSelectedReport] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const active = useRef(null), epoch = useRef(0), form = useRef(null);
  const currency = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: app.currency || 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
  async function refresh(signal, generation = epoch.current) {
    const [records, reports] = await Promise.all([request(`/api/features/${feature.id}/records`, { signal }), request(`/api/features/${feature.id}/analyses`, { signal })]);
    if (!signal?.aborted && generation === epoch.current) { setItems(records.items); setHistory(reports.items); }
  }
  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController(); active.current?.abort(); active.current = null;
    setValues(scenario(feature)); setItems([]); setHistory([]); setResult(null); setSelected(null); setSelectedReport(null); setBusy(''); setError(''); setNotice(''); setLoading(true);
    refresh(controller.signal, generation).catch(failure => { if (!controller.signal.aborted && epoch.current === generation) setError(failure.message); }).finally(() => { if (!controller.signal.aborted && epoch.current === generation) setLoading(false); });
    return () => { epoch.current++; controller.abort(); active.current?.abort(); active.current = null; };
  }, [feature.id]);
  function cancel() { if (!active.current) return; active.current.abort(); active.current = null; setBusy(''); setNotice('Request cancelled. Review the inputs before generating another report.'); }
  async function run(kind) {
    if (busy || !form.current?.reportValidity()) return;
    const controller = new AbortController(), generation = epoch.current; active.current?.abort(); active.current = controller;
    setBusy(kind); setError(''); setNotice(''); setResult(null);
    try {
      const data = await request(`/api/features/${feature.id}/${kind}`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ values, analysisType: kind === 'analyze' ? 'executive-risk-and-value' : 'calculation' }) });
      if (!controller.signal.aborted && active.current === controller && generation === epoch.current) { setResult(data.result); if (kind === 'analyze') await refresh(controller.signal, generation); }
    } catch (failure) { if (!controller.signal.aborted && active.current === controller && generation === epoch.current) setError(failure.message); }
    finally { if (active.current === controller && generation === epoch.current) { active.current = null; setBusy(''); } }
  }
  async function create(event) {
    event.preventDefault(); if (busy || !form.current?.reportValidity()) return;
    const generation = epoch.current; setBusy('create'); setError('');
    try { const data = await request(`/api/features/${feature.id}/records`, { method: 'POST', body: JSON.stringify({ values }) }); if (generation === epoch.current) { notify(data.message); await refresh(undefined, generation); } }
    catch (failure) { if (generation === epoch.current) setError(failure.message); }
    finally { if (generation === epoch.current) setBusy(''); }
  }
  async function changed(item, message) { setSelected(item); notify(message); await refresh(); }
  function preset(type) { if (!busy) { setValues(scenario(feature, type)); setNotice('Example fields filled. These values are fictional and do not represent uploaded or verified evidence.'); setError(''); } }
  const canCreate = ['admin', 'operator'].includes(app.user.role);
  return <><header className="pageTitle"><div><span className="eyebrow">{feature.code}</span><h2>{feature.title}</h2><p>{feature.description}</p></div></header><div className="outcome"><strong>Outcome</strong><span>{feature.outcome}</span></div>
    <div className="workbench"><form ref={form} className="panel" onSubmit={create}><div className="moduleTitle"><div><h3>Domain input workbench</h3><p>Fill a complete example, review the inputs, then request a draft with OpenRouter.</p></div></div><fieldset disabled={!!busy} className="recoveryFieldset"><div className="scenarioRow"><button type="button" onClick={() => preset('standard')}>Fill Standard Case</button><button type="button" onClick={() => preset('high')}>Fill High-Risk Case</button><button type="button" onClick={() => preset('exception')}>Fill Exception Case</button><button type="button" onClick={() => { setValues({}); setNotice(''); }}>Clear All Fields</button></div><div className="formGrid">{feature.fields.map(field => <RecoveryField key={field.key} field={field} value={values[field.key]} onChange={value => setValues(current => ({ ...current, [field.key]: value }))} />)}</div></fieldset>
    <div className="buttonRow"><button type="button" className="primary" onClick={() => run('calculate')} disabled={!!busy}>{busy === 'calculate' ? 'Calculating locally…' : feature.calculateLabel}</button><button type="button" className="aiButton" onClick={() => run('analyze')} disabled={!!busy || !app.ai?.configured}>{busy === 'analyze' ? 'Generating with OpenRouter…' : 'Generate with OpenRouter'}</button>{['analyze', 'calculate'].includes(busy) && <button type="button" className="secondary" onClick={cancel}>Cancel</button>}<button type="submit" className="secondary" disabled={!!busy || !canCreate}>{busy === 'create' ? 'Creating…' : 'Create Operational Case'}</button></div>
    {!app.ai?.configured && <p className="muted">OpenRouter is not configured for this workspace. Configure the existing provider connection to generate a report.</p>}{busy === 'analyze' && <p role="status">OpenRouter is reviewing the entered fields. Cancel stops the request and discards any late response.</p>}{notice && <p className="recoveryNotice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}<small className="muted">Examples are fictional. Local calculations and AI drafts require source validation and the native approval workflow.</small></form><RecoveryReport result={result} /></div>
    <section className="panel"><div className="moduleTitle"><div><h3>{feature.registerTitle}</h3><p>Open a case to review its fields and permitted Edit, Delete or workflow actions.</p></div><span className="badge">{items.length} PostgreSQL records</span></div>{loading ? <p role="status">Loading saved records…</p> : items.length ? <div className="tableWrap"><table><thead><tr><th>Reference</th><th>Case</th><th>Status</th><th>Owner</th><th>Risk</th><th>Due</th><th>Value</th></tr></thead><tbody>{items.map(item => <tr key={item.id} tabIndex={0} onClick={() => setSelected(item)} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setSelected(item); } }}><td>{item.reference}</td><td>{item.title}</td><td>{item.status}</td><td>{item.owner}</td><td>{item.risk}</td><td>{String(item.due_date).slice(0, 10)}</td><td>{currency(item.amount)}</td></tr>)}</tbody></table></div> : <p className="muted">No operational cases are saved for this feature.</p>}</section>
    <section className="panel"><div className="moduleTitle"><div><h3>Saved AI reports</h3><p>Your completed OpenRouter reports remain attributable and open in a centered view.</p></div><span className="badge">{history.length} retained reports</span></div>{history.length ? <div className="tableWrap"><table><thead><tr><th>Report</th><th>Model</th><th>Created</th></tr></thead><tbody>{history.map(report => <tr key={report.id} tabIndex={0} onClick={() => setSelectedReport(report)} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setSelectedReport(report); } }}><td>{report.result?.headline || report.analysis_type}</td><td>{report.provider} · {report.model}</td><td>{new Date(report.created_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <p className="muted">Generate a report to retain its answer and model provenance here.</p>}</section>
    {selected && <RecoveryRecordDialog key={`${selected.id}:${selected.updated_at || ''}`} request={request} feature={feature} item={selected} onClose={() => setSelected(null)} onChanged={changed} />}
    {selectedReport && <RecoveryModal label="Saved AI report" onClose={() => setSelectedReport(null)}><RecoveryReport result={selectedReport.result} /><p className="muted">This generated analysis is retained as read-only evidence. Create a new report for revised inputs.</p><button type="button" className="secondary" onClick={() => setSelectedReport(null)}>Cancel</button></RecoveryModal>}
  </>;
}

export function RecoveryAudit({ request }) {
  const [items, setItems] = useState([]), [selected, setSelected] = useState(null), [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); request('/api/audit-events', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setItems(data.items); }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); }); return () => controller.abort(); }, []);
  return <><header className="pageTitle"><div><span className="eyebrow">Governance</span><h2>Decision audit trail</h2><p>Creation, record changes and AI analysis retain their native attribution.</p></div></header>{error && <p className="error" role="alert">{error}</p>}<div className="tableWrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Reference</th><th>Detail</th></tr></thead><tbody>{items.map(item => <tr key={item.id} tabIndex={0} onClick={() => setSelected(item)} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); setSelected(item); } }}><td>{new Date(item.event_time).toLocaleString()}</td><td>{item.actor}</td><td>{item.action}</td><td>{item.object_reference}</td><td><AIResultValue value={reportValue(item.detail)} /></td></tr>)}</tbody></table></div>{selected && <RecoveryModal label="Audit event" onClose={() => setSelected(null)}><h2>{selected.action} · {selected.object_reference}</h2><div className="detailGrid">{Object.entries(selected).map(([key, value]) => <div key={key}><span>{readableLabel(key)}</span><AIResultValue value={reportValue(value)} /></div>)}</div><p className="muted">Audit events are immutable evidence.</p><button type="button" className="secondary" onClick={() => setSelected(null)}>Cancel</button></RecoveryModal>}</>;
}

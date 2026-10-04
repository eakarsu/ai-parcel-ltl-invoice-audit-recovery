import React, { useEffect, useState } from 'react';

const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
export default function Claims({ request, notify, user }) {
  const [candidates, setCandidates] = useState([]);
  const [claims, setClaims] = useState([]);
  const [selected, setSelected] = useState(null);
  const [creditLines, setCreditLines] = useState([]);
  const [eventType, setEventType] = useState('SUBMITTED');
  const [externalReference, setExternalReference] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  const [creditLineId, setCreditLineId] = useState('');
  const [issuerReference, setIssuerReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const [source, saved] = await Promise.all([request('/api/claims/candidates'), request('/api/claims')]);
    setCandidates(source.items || []);
    setClaims(saved.items || []);
  }
  useEffect(() => { load().catch(err => setError(err.message)); }, []);
  async function open(id) {
    const [detail, credits] = await Promise.all([request(`/api/claims/${id}`), request(`/api/claims/credit-lines?claimId=${id}`)]);
    setSelected(detail); setCreditLines(credits.items || []); setCreditLineId('');
    setEventType(detail.claim.status === 'DRAFT' ? 'SUBMITTED' : 'ACKNOWLEDGED');
  }
  async function act(work) {
    setBusy(true); setError('');
    try { const nextId = await work(); await load(); if (nextId) await open(nextId); else if (selected) await open(selected.claim.id); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const roleCanOperate = ['admin', 'operator'].includes(user.role);
  const eventChoices = selected?.claim.status === 'DRAFT' ? ['SUBMITTED'] : selected?.claim.status === 'SUBMITTED' ? ['ACKNOWLEDGED', 'REJECTED'] : [];
  const selectedEvidence = claims.find(claim => claim.id === selected?.claim.id);
  return <>
    <header className="pageTitle"><div><span className="eyebrow">Customer account {user.account_id}</span><h2>Claims and credit evidence</h2><p>Open a claim from an imported variance, record external correspondence, and link a later statement credit. A linked credit is evidence of a credit line, not proof of paid settlement.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>Unclaimed source-supported variances</h3>
      {candidates.length ? <div className="tableWrap"><table><thead><tr><th>Case</th><th>Capability</th><th>Statement line</th><th>Candidate amount</th><th>Governing source</th><th></th></tr></thead><tbody>{candidates.map(line => <tr key={line.id}><td>{line.record_reference}</td><td>{line.feature_id}</td><td>{line.source_file} #{line.line_number}</td><td>{money(Math.round(Number(line.delta) * 100))}</td><td>{line.parcel_assessment_id ? <>{line.tariff_file} #{line.tariff_line}, v{line.tariff_version}<details><summary>Exact cited line</summary><blockquote>{line.tariff_quote}</blockquote></details></> : 'Case-supported amount'}</td><td><button className="secondary" disabled={busy || !roleCanOperate} onClick={() => act(async () => { const data = await request('/api/claims', { method: 'POST', body: JSON.stringify({ statementLineId: line.id, parcelAssessmentId: line.parcel_assessment_id || undefined }) }); notify('Candidate claim opened; no external submission has occurred.'); return data.claim.id; })}>Open claim</button></td></tr>)}</tbody></table></div> : <p>No unclaimed positive statement variances in this customer account. Fuel and accessorial claims require an approved tariff assessment.</p>}
    </section>
    <section className="panel"><h3>Customer claims</h3>
    {claims.length ? <div className="tableWrap"><table><thead><tr><th>Case</th><th>Status</th><th>Claimed variance</th><th>Statement credit evidence</th><th>Source</th></tr></thead><tbody>{claims.map(claim => <tr key={claim.id}><td><button className="secondary" disabled={busy} onClick={() => act(() => claim.id)}>{claim.record_reference}</button></td><td>{claim.status.replaceAll('_', ' ')}</td><td>{money(claim.requested_cents)}</td><td>{money(claim.credit_cents)}</td><td>{claim.source_file} #{claim.line_number}{claim.parcel_assessment_id && <><br /><small>{claim.tariff_file} #{claim.tariff_line}, v{claim.tariff_version}</small></>}</td></tr>)}</tbody></table></div> : <p>No claims opened yet.</p>}
    </section>
    {selected && <section className="panel"><h3>Claim {selected.claim.id} · {selected.claim.record_reference}</h3>
      <p>Status: <strong>{selected.claim.status.replaceAll('_', ' ')}</strong>. Candidate variance {money(selected.claim.requested_cents)}; linked statement credit {money(selected.claim.credit_cents)}. No paid settlement has been verified.</p>
      {selectedEvidence?.parcel_assessment_id && <p>Tariff evidence: {selectedEvidence.tariff_file} #{selectedEvidence.tariff_line}, version {selectedEvidence.tariff_version}. Exact operator-imported line: <q>{selectedEvidence.tariff_quote}</q>. Carrier authenticity remains unverified.</p>}
      {selected.events.length > 0 && <div><h4>External status evidence entered by staff</h4><ul>{selected.events.map(event => <li key={event.id}>{event.event_type} · {event.external_reference} · SHA-256 {event.evidence_hash.slice(0, 16)}… <details><summary>Copied evidence</summary><pre className="font-sans whitespace-pre-wrap">{event.evidence_text}</pre></details></li>)}</ul></div>}
      {selected.credits.length > 0 && <div><h4>Imported credit lines</h4><ul>{selected.credits.map(credit => <li key={credit.id}>{credit.source_file} #{credit.line_number} · {money(credit.credit_cents)} · issuer reference {credit.issuer_reference} · checksum {credit.checksum.slice(0, 16)}…</li>)}</ul></div>}
      {eventChoices.length > 0 && <form onSubmit={event => { event.preventDefault(); act(async () => { await request(`/api/claims/${selected.claim.id}/events`, { method: 'POST', body: JSON.stringify({ eventType, externalReference, evidenceText }) }); notify('External status recorded from supplied correspondence.'); setExternalReference(''); setEvidenceText(''); }); }}>
        <h4>Record external claim status</h4><div className="formGrid"><label>Status<select value={eventChoices.includes(eventType) ? eventType : eventChoices[0]} onChange={event => setEventType(event.target.value)}>{eventChoices.map(choice => <option key={choice}>{choice}</option>)}</select></label><label>External reference<input minLength={5} maxLength={200} required value={externalReference} onChange={event => setExternalReference(event.target.value)}/></label></div>
        <label>Copied portal or correspondence evidence<textarea minLength={20} maxLength={10000} required value={evidenceText} onChange={event => setEvidenceText(event.target.value)} /></label><button className="primary" disabled={busy || (eventChoices[0] === 'SUBMITTED' ? !roleCanOperate : !['admin', 'operator', 'reviewer'].includes(user.role))}>Record status evidence</button>
      </form>}
      {['ACKNOWLEDGED', 'PARTIAL_CREDIT'].includes(selected.claim.status) && <form onSubmit={event => { event.preventDefault(); act(async () => { await request(`/api/claims/${selected.claim.id}/credits`, { method: 'POST', body: JSON.stringify({ creditLineId: Number(creditLineId), issuerReference }) }); notify('Imported credit line linked. Paid settlement remains unverified.'); setIssuerReference(''); }); }}>
        <h4>Link later imported credit line</h4><div className="formGrid"><label>Credit line<select required value={creditLineId} onChange={event => setCreditLineId(event.target.value)}><option value="">Select a credit line</option>{creditLines.map(line => <option key={line.id} value={line.id}>{line.source_file} #{line.line_number} · {money(-Math.round(Number(line.amount) * 100))} · {line.reference}</option>)}</select></label><label>Issuer credit reference<input minLength={5} maxLength={200} required value={issuerReference} onChange={event => setIssuerReference(event.target.value)}/></label></div><button className="primary" disabled={busy || !roleCanOperate || !creditLineId}>Link statement credit evidence</button><p>Import a later issuer statement with a negative credit line referencing this case. Parcel claims also require the same imported charge type. Statement credit and paid settlement remain distinct.</p>
      </form>}
    </section>}
  </>;
}

import React, { useEffect, useState } from 'react';

const formatMoney = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
}).format(Number(value || 0));

export default function StatementIngest({ features, request, notify, onSaved }) {
  const [featureId, setFeatureId] = useState(features[0]?.id || '');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function loadHistory() {
    try {
      const data = await request('/api/statement-ingests');
      setHistory(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { loadHistory(); }, []);

  async function submit(event) {
    event.preventDefault();
    if (!featureId || !file) return;
    if (file.size > 750000) {
      setError('Choose a CSV or JSON statement smaller than 750 KB.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
      const data = await request(`/api/features/${encodeURIComponent(featureId)}/ingest`, {
        method: 'POST',
        body: JSON.stringify({ text: await file.text(), format, sourceFile: file.name }),
      });
      setResult(data);
      notify(data.alreadyIngested ? 'This statement was already imported.' : 'Statement imported. Review every exception and source amount.');
      await loadHistory();
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openIngest(id) {
    setBusy(true);
    setError('');
    try {
      const data = await request(`/api/statement-ingests/${id}`);
      setResult({
        sourceFile: data.item.source_file,
        checksum: data.item.checksum,
        reconciliation: data.item.reconciliation,
        parsed: { rowCount: data.item.row_count, rejected: data.lines.filter(line => line.reconciliation_status === 'rejected') },
        alreadyIngested: true,
        ingestId: id,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const summary = result?.reconciliation?.summary;
  const groups = result?.reconciliation
    ? [
        ['Source-supported variance', result.reconciliation.confirmed],
        ['Matched', result.reconciliation.matched],
        ['Needs source/rule review', result.reconciliation.assumed],
        ['Credits in statement', result.reconciliation.credits],
        ['No positive variance', result.reconciliation.noRecovery],
        ['Unmatched', result.reconciliation.unmatched],
        ['Example records excluded', result.reconciliation.ignored],
      ]
    : [];

  return <>
    <header className="pageTitle"><div><span className="eyebrow">Source evidence</span><h2>Statement import</h2><p>Match statement lines to existing case references. A positive variance is a candidate for review, not a paid refund or credit.</p></div></header>
    <section className="panel">
      <h3>Import a CSV or JSON statement</h3>
      <p>Required columns: reference, description, amount. Each reference must match a case in the selected capability. Fuel and accessorial imports also need <code>charge_type</code> matching the cited tariff; fuel lines need <code>base_freight_amount</code> and a date. Import later credits with the same charge type so they can be linked to an assessed claim. Complete tariff approval and assessment under Carrier Tariff Review.</p>
      <form onSubmit={submit}>
        <div className="formGrid">
          <label>Capability<select value={featureId} onChange={event => setFeatureId(event.target.value)} required>{features.map(feature => <option key={feature.id} value={feature.id}>{feature.title}</option>)}</select></label>
          <label>Statement file<input type="file" accept=".csv,.json,text/csv,application/json" onChange={event => setFile(event.target.files?.[0] || null)} required /></label>
        </div>
        <button className="primary" disabled={busy || !featureId || !file}>{busy ? 'Working…' : 'Import and reconcile'}</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
    {result && <section className="panel">
      <h3>{result.sourceFile}</h3>
      <p>Checksum: <code>{result.checksum}</code>. {result.alreadyIngested ? 'Previously imported statement.' : 'New statement saved.'}</p>
      <div className="metrics">
        <div className="metric"><span>Parsed lines</span><strong>{result.parsed?.rowCount ?? 0}</strong></div>
        <div className="metric"><span>Rejected lines</span><strong>{result.parsed?.rejected?.length || 0}</strong></div>
        <div className="metric"><span>Source-supported variance</span><strong>{formatMoney(summary?.confirmedRecovery)}</strong></div>
        <div className="metric"><span>Needs review</span><strong>{summary?.assumedEntries || 0}</strong></div>
      </div>
      <p><strong>No recovered money is verified here.</strong> Confirm a claim or received credit separately with the issuer and payment evidence.</p>
      {result.parsed?.rejected?.length > 0 && <div><h4>Rejected lines</h4><ul>{result.parsed.rejected.map((line, index) => <li key={index}>Line {line.line || line.line_number}: {line.reason || line.rejection_reason}</li>)}</ul></div>}
      {groups.map(([label, entries]) => entries?.length > 0 && <div key={label}>
        <h4>{label} ({entries.length})</h4>
        <div className="tableWrap"><table><thead><tr><th>Line</th><th>Reference</th><th>Statement amount</th><th>Expected amount</th><th>Variance</th><th>Reason</th></tr></thead><tbody>{entries.map((entry, index) => <tr key={`${entry.line}-${index}`}><td>{entry.line}</td><td>{entry.reference}</td><td>{formatMoney(entry.statementAmount)}</td><td>{entry.expectedAmount == null ? '—' : formatMoney(entry.expectedAmount)}</td><td>{entry.signedRecovery == null ? '—' : formatMoney(entry.signedRecovery)}</td><td>{entry.reason || 'Matched to the configured rule'}</td></tr>)}</tbody></table></div>
      </div>)}
    </section>}
    <section className="panel"><h3>Recent imports</h3>{history.length ? <div className="tableWrap"><table><thead><tr><th>File</th><th>Capability</th><th>Rows</th><th>Source-supported variance</th></tr></thead><tbody>{history.map(item => <tr key={item.id} onClick={() => openIngest(item.id)}><td><button type="button" className="secondary" disabled={busy}>{item.source_file}</button></td><td>{features.find(feature => feature.id === item.feature_id)?.title || item.feature_id}</td><td>{item.row_count}</td><td>{formatMoney(item.confirmed_recovery)}</td></tr>)}</tbody></table></div> : <p>No statements imported yet.</p>}</section>
  </>;
}

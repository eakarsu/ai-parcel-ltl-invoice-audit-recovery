import React, { useState } from 'react';
import { AIResultValue, reportValue, reportText } from './RecoveryReportValue.jsx';

export default function RecoveryReport({ result }) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('');
  if (!result) return null;
  const value = reportValue(result), text = reportText(value);
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setCopyError(''); } catch { setCopyError('Clipboard access is unavailable. Download the report or select its text to copy it.'); } }
  function download() { const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'decision-report.txt'; link.click(); URL.revokeObjectURL(url); }
  return <section className="result recoveryReport" aria-label="Decision report">
    <header className="resultHead"><div><span className="eyebrow">{result.provider || 'Saved report'} · {result.model || 'Model not recorded'}</span><h3>{result.headline || 'Saved analysis'}</h3></div><div><span className={`risk risk-${String(result.risk || 'Not assessed').toLowerCase().replace(/\s+/g,'-')}`}>{result.risk || 'Not assessed'}</span><small>Confidence not measured</small></div></header>
    <div className="recoveryProse"><AIResultValue value={reportValue(result.executiveSummary || value)} /></div>
    {Array.isArray(result.metrics) && result.metrics.length > 0 && <div className="resultMetrics">{result.metrics.map((metric, index) => <article className="metric" key={index}><span>{metric.label}</span><div><AIResultValue value={reportValue(metric.value)} /></div></article>)}</div>}
    {Array.isArray(result.sections) && <div className="sections">{result.sections.map((section, index) => <article key={index}><h4>{section.title}</h4><AIResultValue value={reportValue(section.detail)} /></article>)}</div>}
    {Array.isArray(result.actions) && result.actions.length > 0 && <div className="actions"><h4>Recommended actions</h4>{result.actions.map((action, index) => <div key={index}><span>{index + 1}</span><div><AIResultValue value={reportValue(action)} /></div></div>)}</div>}
    {result.disclaimer && <small className="disclaimer">{result.disclaimer}</small>}
    <div className="buttonRow recoveryReportTools"><button type="button" className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy report'}</button><button type="button" className="secondary" onClick={download}>Download report</button></div>{copyError && <p role="status">{copyError}</p>}
  </section>;
}

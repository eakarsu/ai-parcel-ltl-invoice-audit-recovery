import React, { useEffect, useRef, useState } from 'react';
import { AIResultValue, reportValue } from './RecoveryReportValue.jsx';
import { readableLabel } from './recoveryFields.mjs';

export function RecoveryModal({ label, onClose, busy = false, children }) {
  const element = useRef(null), close = useRef(onClose), pending = useRef(busy); close.current = onClose; pending.current = busy;
  useEffect(() => {
    const previous = document.activeElement, overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element.current?.querySelector('button:not(:disabled),input:not(:disabled),[tabindex="0"]')?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!pending.current) close.current(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(element.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') || [])];
      if (!nodes.length) { event.preventDefault(); element.current?.focus(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, []);
  return <div className="modalBack recoveryModalBack" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={element} tabIndex={-1} className="modal recoveryModal" role="dialog" aria-modal="true" aria-label={label}><button type="button" className="close" aria-label="Close details" disabled={busy} onClick={onClose}>×</button>{children}</section></div>;
}

export function RecoveryField({ field, value, onChange, disabled = false }) {
  const common = { value: value ?? '', onChange: event => onChange(event.target.value), required: field.required, disabled };
  return <label>{field.label}{!field.required && <span className="muted"> (optional)</span>}{field.type === 'select' ? <select {...common}><option value="">Select…</option>{(field.options || []).map(option => <option key={option} value={option}>{option}</option>)}</select> : field.type === 'textarea' ? <textarea {...common} rows={4} /> : <input {...common} type={['number', 'currency'].includes(field.type) ? 'number' : field.type || 'text'} min={field.min ?? (field.type === 'currency' ? 0 : undefined)} max={field.max} step={field.type === 'currency' ? '0.01' : 'any'} />}<small>{field.help}</small></label>;
}

export default function RecoveryRecordDialog({ request, feature, item, onClose, onChanged }) {
  const [detail, setDetail] = useState(null), [editing, setEditing] = useState(false), [confirmDelete, setConfirmDelete] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState(null);
  const active = useRef(true), form = useRef(null);
  const path = `/api/features/${feature.id}/records/${item.id}`;
  const fields = row => ({ title: row.title, owner: row.owner, due_date: String(row.due_date || '').slice(0, 10), risk: row.risk, amount: row.amount, values: Object.fromEntries(feature.fields.map(field => [field.key, row.payload?.[field.key] ?? ''])) });
  async function reload(signal) { const data = await request(path, { signal }); if (!signal?.aborted && active.current) { setDetail(data); setDraft(fields(data.item)); } }
  useEffect(() => { active.current = true; const controller = new AbortController(); reload(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure.message); }); return () => { active.current = false; controller.abort(); }; }, [path]);
  const row = detail?.item || item, policy = detail?.permissions || {};
  const change = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  async function mutate(kind, status) {
    if (busy || !detail) return;
    if (kind === 'save' && !form.current?.reportValidity()) return;
    setBusy(true); setError('');
    try {
      let body = { recordVersion: row.record_version }, method = 'DELETE', url = path;
      if (kind === 'save') { method = 'PUT'; body = { recordVersion: row.record_version, title: draft.title, owner: draft.owner, due_date: draft.due_date, values: draft.values, ...(!policy.accountScoped ? { risk: draft.risk, amount: draft.amount } : {}) }; }
      if (kind === 'transition') { method = 'POST'; url += '/transition'; body = { status, ...(policy.accountScoped ? { expectedVersion: row.payload?.__version ?? 0 } : { recordVersion: row.record_version }) }; }
      const result = await request(url, { method, body: JSON.stringify(body) });
      if (active.current) { setEditing(false); setConfirmDelete(false); await onChanged(result.item || null, result.message); }
    } catch (failure) { if (active.current) { setError(failure.message); setConfirmDelete(false); } } finally { if (active.current) setBusy(false); }
  }
  return <RecoveryModal label={`${row.reference} details`} onClose={onClose} busy={busy}><span className="eyebrow">{row.reference}</span><h2>{row.title}</h2>{!detail && !error && <p role="status">Loading current record and permissions…</p>}
    {editing && draft ? <form ref={form} onSubmit={event => { event.preventDefault(); mutate('save'); }}><fieldset disabled={busy} className="recoveryFieldset"><div className="formGrid"><label>Case title<input required maxLength={policy.accountScoped ? 1000 : 300} value={draft.title} onChange={event => change('title', event.target.value)} /></label><label>Owner<input required maxLength={200} value={draft.owner} onChange={event => change('owner', event.target.value)} /></label><label>Due date<input required type="date" value={draft.due_date} onChange={event => change('due_date', event.target.value)} /></label>{!policy.accountScoped && <><label>Risk<select value={draft.risk} onChange={event => change('risk', event.target.value)}>{['Low', 'Moderate', 'High', 'Critical'].map(value => <option key={value}>{value}</option>)}</select></label><label>Amount<input required type="number" min={0} step="0.01" value={draft.amount} onChange={event => change('amount', event.target.value)} /></label></>}{feature.fields.map(field => <RecoveryField key={field.key} field={field} value={draft.values[field.key]} onChange={value => setDraft(current => ({ ...current, values: { ...current.values, [field.key]: value } }))} />)}</div></fieldset></form> : <><div className="detailGrid">{['reference', 'status', 'owner', 'risk', 'due_date', 'amount', 'created_at', 'updated_at'].map(key => <div key={key}><span>{readableLabel(key)}</span><AIResultValue value={reportValue(row[key])} /></div>)}{feature.fields.map(field => <div key={field.key}><span>{field.label}</span><AIResultValue value={reportValue(row.payload?.[field.key])} /></div>)}</div>{policy.allowedTransitions?.length > 0 && <><h4>Advance governed workflow</h4><div className="buttonRow">{policy.allowedTransitions.map(status => <button type="button" className="secondary" key={status} disabled={busy} onClick={() => mutate('transition', status)}>{status}</button>)}</div></>}</>}
    {error && <p className="error" role="alert">{error}</p>}{policy.reason && <p className="muted">{policy.reason}</p>}
    {confirmDelete ? <div className="recordDeleteConfirm"><strong>Delete this operational case permanently?</strong><p>Its retained audit history remains available.</p><div className="buttonRow"><button type="button" className="danger" disabled={busy} onClick={() => mutate('delete')}>Delete now</button><button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button></div></div> : <div className="buttonRow recordModalActions">{editing ? <button type="button" className="primary" disabled={busy} onClick={() => mutate('save')}>{busy ? 'Saving…' : 'Save changes'}</button> : <button type="button" className="primary" disabled={busy || !policy.canEdit} onClick={() => { setDraft(fields(row)); setError(''); setEditing(true); }}>Edit</button>}{!editing && <button type="button" className="danger" disabled={busy || !policy.canDelete} onClick={() => setConfirmDelete(true)}>Delete</button>}<button type="button" className="secondary" disabled={busy} onClick={editing ? () => { setDraft(fields(row)); setEditing(false); setError(''); } : onClose}>Cancel</button></div>}
    {!policy.reason && detail && <small className="muted">Administrators and operators can edit. Deletion requires an administrator. Workflow approval uses the native role and evidence rules.</small>}
  </RecoveryModal>;
}

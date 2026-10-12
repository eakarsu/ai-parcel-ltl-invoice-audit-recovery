/** Examples use every declared field and remain distinct from persisted source evidence. */
export function scenario(feature, type = 'standard') {
  return Object.fromEntries(feature.fields.map(field => {
    let value = field[type] ?? field.sample ?? '';
    if (field.type === 'select' && !field.options.includes(value)) value = field.options[type === 'high' ? Math.min(1, field.options.length - 1) : type === 'exception' ? Math.min(2, field.options.length - 1) : 0] ?? '';
    return [field.key, value];
  }));
}
export function readableLabel(value) { return String(value || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, letter => letter.toUpperCase()); }

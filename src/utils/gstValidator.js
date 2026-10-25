// Regular PAN-based GST registrations. UIN/temporary registration IDs are not GSTINs.
export const normalizeGSTIN = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstChecksum(first14) {
  let sum = 0, factor = 2;
  for (let i = first14.length - 1; i >= 0; i--) {
    const product = alphabet.indexOf(first14[i]) * factor;
    sum += Math.floor(product / 36) + product % 36;
    factor = factor === 2 ? 1 : 2;
  }
  return alphabet[(36 - sum % 36) % 36];
}
export function gstValidationError(value) {
  const gstin = normalizeGSTIN(value);
  if (gstin.length !== 15) return 'GSTIN must contain exactly 15 characters';
  if (!/^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return 'Enter a valid PAN-based GSTIN structure';
  if (gstChecksum(gstin.slice(0, 14)) !== gstin[14]) return 'GSTIN checksum is invalid. Check the number';
  return '';
}

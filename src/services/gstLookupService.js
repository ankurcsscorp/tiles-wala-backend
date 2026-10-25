import jwt from 'jsonwebtoken';
import { createGSTProvider } from '../providers/gstProvider.js';
import { configurationError, GSTError } from './gstErrors.js';
import { gstValidationError, normalizeGSTIN } from '../utils/gstValidator.js';

// Only coalesce concurrent calls; caching is disabled until provider retention terms are agreed.
export function createGSTLookupService(providerFactory = createGSTProvider) {
  const pending = new Map();
  return async (value) => {
    const gstin = normalizeGSTIN(value), invalid = gstValidationError(gstin);
    if (invalid) throw new GSTError('GST_INVALID', 400, invalid);
    if (!process.env.JWT_SECRET) throw configurationError();
    if (pending.has(gstin)) return pending.get(gstin);
    const task = (async () => {
      const data = await providerFactory().lookup(gstin);
      const lookupToken = jwt.sign({ gstin, source: data.source, fetchedAt: data.fetchedAt }, process.env.JWT_SECRET, { expiresIn: '30m', audience: 'gst-lookup', issuer: 'tiles-wala' });
      return { data, lookupToken };
    })();
    pending.set(gstin, task);
    try { return await task; } finally { pending.delete(gstin); }
  };
}
export const lookupGST = createGSTLookupService();

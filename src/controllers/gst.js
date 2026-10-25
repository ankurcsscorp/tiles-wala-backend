import { lookupGST } from '../services/gstLookupService.js';
import { GSTError } from '../services/gstErrors.js';
import { connection } from '../../connection.js';

export async function requireGSTAccess(req, res, next) {
  if (req.user.userType.toLowerCase() === 'admin') return next();
  try {
    const result = await connection.query('SELECT 1 FROM user_store_assignments usa JOIN stores s ON s.id=usa.store_id WHERE usa.user_id=$1 AND usa.is_active=TRUE AND s.is_active=TRUE LIMIT 1', [req.user.id]);
    if (!result.rows.length) return res.status(403).json({ success: false, code: 'GST_FORBIDDEN', message: 'An active store assignment is required to look up GST details.' });
    return next();
  } catch { return res.status(503).json({ success: false, code: 'GST_UNAVAILABLE', message: 'Unable to verify GST lookup permissions.' }); }
}
export const createLookupController = (lookup = lookupGST) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ success: true, ...await lookup(req.params.gstin) }); }
  catch (error) {
    const known = error instanceof GSTError;
    if (known && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    console.warn('GST lookup failed', { code: known ? error.code : 'GST_INTERNAL' });
    res.status(known ? error.status : 503).json({ success: false, code: known ? error.code : 'GST_UNAVAILABLE', message: known ? error.message : 'GST service is temporarily unavailable. Please retry later.' });
  }
};
export const lookupGSTController = createLookupController();

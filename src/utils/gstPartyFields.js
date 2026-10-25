import jwt from 'jsonwebtoken';

const limits = { legalName: 180, tradeName: 180, registrationStatus: 80, taxpayerType: 100, constitutionOfBusiness: 150, district: 100, stateCode: 2, registrationDate: 10 };
export function gstPartyFields(body, gstin) {
  let details = null;
  if (body.gstDetails !== undefined) {
    if (!body.gstDetails || typeof body.gstDetails !== 'object' || Array.isArray(body.gstDetails)) return { error: 'GST business details must be an object' };
    details = {};
    for (const [key, limit] of Object.entries(limits)) {
      const value = body.gstDetails[key];
      if (value != null && (typeof value !== 'string' || value.length > limit)) return { error: `Invalid GST ${key}` };
      details[key] = typeof value === 'string' ? value.trim() : '';
    }
    const activities = body.gstDetails.natureOfBusiness || [];
    if (!Array.isArray(activities) || activities.length > 30 || activities.some((entry) => typeof entry !== 'string' || entry.length > 150)) return { error: 'Invalid GST business activities' };
    details.natureOfBusiness = activities.map((entry) => entry.trim()).filter(Boolean);
    if (details.registrationDate && (!/^\d{4}-\d{2}-\d{2}$/.test(details.registrationDate) || Number.isNaN(Date.parse(details.registrationDate)) || new Date(details.registrationDate).toISOString().slice(0, 10) !== details.registrationDate)) return { error: 'Invalid GST registration date' };
  }
  let verifiedAt = null, source = null;
  if (body.gstLookupToken) {
    try {
      const proof = jwt.verify(body.gstLookupToken, process.env.JWT_SECRET, { audience: 'gst-lookup', issuer: 'tiles-wala', algorithms: ['HS256'] });
      if (proof.gstin !== gstin || !['finagg', 'finagg-sandbox'].includes(proof.source) || !Number.isFinite(Date.parse(proof.fetchedAt))) throw new Error('Invalid lookup proof');
      verifiedAt = proof.fetchedAt; source = proof.source;
    } catch { return { error: 'GST lookup verification expired or does not match this GSTIN. Fetch again, or clear the lookup verification and save manually.' }; }
  }
  return { details, verifiedAt, source };
}

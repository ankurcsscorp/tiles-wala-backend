import { GSTError, configurationError } from '../services/gstErrors.js';
import { normalizeGSTIN } from '../utils/gstValidator.js';

const text = (value, length = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, length) : '';
const date = (value) => {
  const raw = text(value, 10);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : raw;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
};
// Only explicitly supported GSTN fields leave the adapter. Never retain the raw payload.
export function normalizeTaxpayer(payload, requestedGSTIN, source = 'finagg') {
  let row = payload?.data;
  if (typeof row === 'string') { try { row = JSON.parse(row); } catch { row = null; } }
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new GSTError('GST_INVALID_RESPONSE', 502, 'GST service returned an incomplete response. Please retry later.');
  if (normalizeGSTIN(row.gstin) !== requestedGSTIN) throw new GSTError('GST_INVALID_RESPONSE', 502, 'GST service returned details for a different GSTIN.');
  const address = row.pradr?.addr || {};
  return {
    gstin: requestedGSTIN, legalName: text(row.lgnm, 180), tradeName: text(row.tradeNam, 180),
    registrationStatus: text(row.sts, 80), taxpayerType: text(row.dty, 100), constitutionOfBusiness: text(row.ctb, 150),
    registrationDate: date(row.rgdt),
    address: {
      addressLine1: [text(address.bno), text(address.bnm), text(address.flno)].filter(Boolean).join(', ').slice(0, 500),
      addressLine2: text(address.st, 500), city: text(address.loc, 100), district: text(address.dst, 100),
      state: text(address.stcd, 100), stateCode: requestedGSTIN.slice(0, 2), pincode: text(address.pncd, 12),
    },
    natureOfBusiness: Array.isArray(row.nba) ? row.nba.slice(0, 30).map((entry) => text(entry, 150)).filter(Boolean) : [],
    source, fetchedAt: new Date().toISOString(),
  };
}

export function createGSTProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const versions = [env.GST_FINAGG_VERSION, env.GST_GSP_VERSION];
  if (env.GST_PROVIDER !== 'finagg' || !env.GST_API_KEY || versions.some((version) => !/^[a-zA-Z0-9._-]+$/.test(version || '')) || !['production', 'sandbox'].includes(env.GST_ENVIRONMENT)) throw configurationError();
  const host = env.GST_ENVIRONMENT === 'sandbox' ? 'sandbox-gsp.finagg.in' : 'gsp.finagg.in';
  const timeout = Math.min(20000, Math.max(1000, Number(env.GST_TIMEOUT_MS) || 8000));
  return {
    async lookup(gstin) {
      const url = new URL(`https://${host}/basic/gstn/${versions[0]}/commonapi/${versions[1]}/search`);
      url.searchParams.set('action', 'SEARCHGSTIN'); url.searchParams.set('gstin', gstin);
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetchImpl(url, { headers: { 'x-api-key': env.GST_API_KEY, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
          if ([502, 503, 504].includes(response.status) && attempt === 0) { await response.body?.cancel(); continue; }
          if ([401, 403].includes(response.status)) throw new GSTError('GST_PROVIDER_CREDENTIALS', 503, 'GST provider credentials or access permissions need attention. Contact your administrator.');
          if (response.status === 404) throw new GSTError('GST_NOT_FOUND', 404, 'GSTIN was not found in the GST registry.');
          if (response.status === 429) {
            const delay = Number(response.headers.get('retry-after'));
            throw new GSTError('GST_RATE_LIMITED', 429, 'GST lookup rate limit exceeded. Please try again later.', Number.isFinite(delay) && delay > 0 ? Math.min(delay, 3600) : 60);
          }
          if (!response.ok) throw new GSTError('GST_UNAVAILABLE', 503, 'GST service is temporarily unavailable. Please try again later.');
          // Bound data read as well as the request; business data responses should be small.
          let size = 0; const chunks = [];
          for await (const chunk of response.body) { size += chunk.length; if (size > 65536) { controller.abort(); throw new GSTError('GST_INVALID_RESPONSE', 502, 'GST service returned an invalid response.'); } chunks.push(Buffer.from(chunk)); }
          let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GSTError('GST_INVALID_RESPONSE', 502, 'GST service returned an invalid response.'); }
          if (String(payload.status_cd) === '0' || payload.error) {
            throw new GSTError('GST_UNAVAILABLE', 503, 'GST provider could not complete this lookup. Please retry later.');
          }
          return normalizeTaxpayer(payload, gstin, env.GST_ENVIRONMENT === 'sandbox' ? 'finagg-sandbox' : 'finagg');
        } catch (error) {
          if (error instanceof GSTError) throw error;
          if (controller.signal.aborted) throw new GSTError('GST_TIMEOUT', 504, 'GST lookup timed out. Please try again.');
          throw new GSTError('GST_UNAVAILABLE', 503, 'GST service is temporarily unavailable. Please try again later.');
        } finally { clearTimeout(timer); }
      }
    },
  };
}

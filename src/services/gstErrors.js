export class GSTError extends Error {
  constructor(code, status, message, retryAfter) { super(message); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export const configurationError = () => new GSTError('GST_CONFIGURATION_REQUIRED', 503, 'GST lookup is not configured. Ask your administrator to configure the GST provider.');

export const relayConfig = {
  port: parseInt(process.env.RELAY_PORT || '3457', 10),
  token: process.env.RELAY_TOKEN || '',
  /** Optional domain for nginx proxy mode (not required for direct IP access) */
  domain: process.env.RELAY_DOMAIN || '',
  /** @deprecated Use DASHBOARD_PASSWORD on the local server instead */
  password: process.env.RELAY_PASSWORD || '',
};

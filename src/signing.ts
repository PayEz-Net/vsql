import { createHmac } from 'crypto';

/**
 * KEY-SIGNING (v1.3.0, PAY-1738): sign a call to the identity service's VibeSQL proxy with the KeelBase client id and
 * KeelBase secret from the portal's KeelBase page (the SDK calls them VIBE_CLIENT_ID / VIBE_HMAC_KEY).
 *
 * The contract is the verifier's, read at source (PayEz-Core VibeProxyController.ComputeHmacSignature and :120-122):
 *
 *   stringToSign = "{unix seconds}|{METHOD, upper-case}|{endpoint}"      (endpoint exactly as sent in the body)
 *   signature    = base64( HMAC-SHA256( key = base64DECODE(secret), UTF-8(stringToSign) ) )
 *
 * The signature does NOT cover the request body. The proxy accepts a timestamp up to 5 minutes old and 1 minute
 * ahead. Pinned by the vectors in test/signing.test.mjs, computed by the verifier itself (DotNetPert-Scout 63513).
 */
export function signProxyRequest(secretB64: string, timestamp: number, method: string, endpoint: string): string {
  const key = decodeSecret(secretB64);
  return createHmac('sha256', key).update(`${timestamp}|${method.toUpperCase()}|${endpoint}`, 'utf8').digest('base64');
}

/**
 * Decode the secret STRICTLY. Buffer.from(s, 'base64') silently skips characters that are not base64, so a mistyped
 * or truncated secret would sign with the wrong key and surface only as a server-side SIGNATURE_MISMATCH. The .NET
 * verifier's Convert.FromBase64String is strict, so this is too: standard alphabet, padded, length a multiple of 4.
 */
export function decodeSecret(secretB64: string): Buffer {
  const s = secretB64.trim();
  if (s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw new Error('the KeelBase secret is not valid base64 (copy it again from the KeelBase page)');
  }
  const key = Buffer.from(s, 'base64');
  if (key.length < 16) throw new Error('the KeelBase secret is too short to be one the KeelBase page issued');
  return key;
}

/** Unix seconds, the unit X-Vibe-Timestamp carries. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

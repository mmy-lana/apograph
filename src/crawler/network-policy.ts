import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface NetworkPolicyOptions {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }> | { address: string; family: number }>;
}

function ipv4Blocked(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}

function ipv6Blocked(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1' || lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return ipv4Blocked(lower.slice(7));
  return false;
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? ipv4Blocked(address) : family === 6 ? ipv6Blocked(address) : true;
}

/** Validates an outbound URL and all resolved addresses against the public-web policy. */
export async function validateNetworkUrl(raw: string, options: NetworkPolicyOptions = {}): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'localhost.localdomain' || hostname === 'metadata.google.internal') {
    throw new Error(`Restricted network destination: ${hostname}`);
  }
  const resolver = options.resolve ?? (async (host: string) => lookup(host, { all: true }));
  const resolved = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname);
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.length === 0 || addresses.some((entry) => blockedAddress(entry.address))) {
    throw new Error(`Restricted network destination: ${hostname}`);
  }
  return url;
}

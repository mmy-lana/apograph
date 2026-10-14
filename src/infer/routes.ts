/**
 * apograph — URL clustering & route pattern inference (Layer 3: Contracts).
 *
 * Pure deterministic logic — no LLM calls, zero token cost. Groups harvested
 * requests into endpoint clusters by parameterizing URL path segments.
 */

import type { RecordedRequest, EndpointCluster } from '../types.js';

/** Max number of sample URLs retained per cluster. */
const MAX_SAMPLE_URLS = 5;

/** Static segments that must never be parameterized. */
const STATIC_SEGMENTS = new Set<string>([
  'api',
  'v1',
  'v2',
  'v3',
  'v4',
  'users',
  'user',
  'projects',
  'project',
  'auth',
  'login',
  'logout',
  'signup',
  'register',
  'checkout',
  'cart',
  'orders',
  'order',
  'products',
  'product',
  'workspaces',
  'workspace',
  'orgs',
  'org',
  'members',
  'member',
  'teams',
  'team',
  'settings',
  'profile',
  'search',
  'list',
  'detail',
  'items',
  'item',
  'files',
  'file',
  'uploads',
  'upload',
  'sessions',
  'session',
  'tokens',
  'token',
  'keys',
  'key',
  'health',
  'status',
  'metrics',
  'config',
  'preferences',
  'notifications',
  'notification',
  'messages',
  'message',
  'comments',
  'comment',
  'posts',
  'post',
  'articles',
  'article',
  'categories',
  'category',
  'tags',
  'tag',
  'billing',
  'invoices',
  'invoice',
  'payments',
  'payment',
  'subscriptions',
  'subscription',
  'plans',
  'plan',
  'accounts',
  'account',
]);

// ---------------------------------------------------------------------------
// Parameterization
// ---------------------------------------------------------------------------

/** Pure numeric segment (integers, possibly negative). */
const NUMERIC_RE = /^-?\d+$/;

/** UUID / GUID (canonical 8-4-4-4-12 hex form). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prefixed IDs: usr_..., org_..., ws_..., proj_..., usr-..., etc. */
const PREFIXED_ID_RE =
  /^(usr|org|ws|proj|prj|acct|cust|team|tm|grp|inv|clt|mbr|mem|file|doc|msg|img|vid)[_-].+$/i;

/** Mongo ObjectID (24 hex chars) or MD5/SHA-style hash (32/40/64 hex chars). */
const HEX_HASH_RE = /^(?:[0-9a-f]{24}|[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Base64-ish opaque token (long, no dictionary meaning). */
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Parameterizes a URL pathname into a normalized route pattern.
 *
 * Examples:
 *   /api/v1/users/123          -> /api/v1/users/:id
 *   /api/orgs/org_abc/members  -> /api/orgs/:id/members
 *   /files/550e8400-e29b-...   -> /files/:uuid
 *   /assets/507f1f77bcf86cd799b4390a -> /assets/:hash
 *   /blog/my-post-title        -> /blog/:slug
 */
export function parameterizePath(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);

  const parameterized = segments.map((segment) => {
    // Decode percent-encoding before classification.
    const decoded = safeDecode(segment);

    if (STATIC_SEGMENTS.has(decoded.toLowerCase())) {
      return decoded;
    }

    return classifySegment(decoded);
  });

  return parameterized.length > 0 ? `/${parameterized.join('/')}` : '/';
}

/**
 * Classifies a single dynamic path segment into a parameter placeholder.
 * Static dictionary segments are handled by the caller.
 */
function classifySegment(segment: string): string {
  if (NUMERIC_RE.test(segment)) return ':id';

  if (UUID_RE.test(segment)) return ':uuid';

  if (PREFIXED_ID_RE.test(segment)) return ':id';

  if (HEX_HASH_RE.test(segment)) return ':hash';

  // Slug: multiple words joined by separators, containing at least one
  // alphabetic character (e.g. `my-post-title`, `Q3 Report`).
  if (isSlug(segment)) return ':slug';

  // Long opaque alphanumeric token (JWT fragments, random IDs).
  if (OPAQUE_TOKEN_RE.test(segment)) return ':token';

  return segment;
}

/** True when a segment looks like a human-readable slug. */
function isSlug(segment: string): boolean {
  const hasAlpha = /[A-Za-z]/.test(segment);
  const multiWord = segment.split(/[-_.\s]+/).filter(Boolean).length >= 2;
  return hasAlpha && multiWord;
}

/** Percent-decodes a segment without throwing on malformed escapes. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Groups recorded requests into endpoint clusters keyed by their
 * parameterized route pattern. Returns clusters sorted alphabetically.
 */
export function clusterEndpoints(requests: RecordedRequest[]): EndpointCluster[] {
  const clusters = new Map<
    string,
    { urls: Set<string>; methods: Set<string> }
  >();

  for (const request of requests) {
    const pathname = extractPathname(request.url);
    const pattern = parameterizePath(pathname);

    let cluster = clusters.get(pattern);
    if (!cluster) {
      cluster = { urls: new Set<string>(), methods: new Set<string>() };
      clusters.set(pattern, cluster);
    }

    cluster.urls.add(request.url);
    cluster.methods.add(request.method.toUpperCase());
  }

  return [...clusters.entries()]
    .map(([pattern, cluster]) => ({
      pattern,
      sampleUrls: [...cluster.urls].slice(0, MAX_SAMPLE_URLS),
      methods: [...cluster.methods].sort(),
    }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** Extracts the pathname from a URL without throwing on malformed input. */
function extractPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Returns a new array of requests with each `routePattern` field populated
 * from its parameterized URL pattern. The input array is not mutated.
 */
export function enrichRequestsWithRoutePatterns(
  requests: RecordedRequest[],
): RecordedRequest[] {
  return requests.map((request) => ({
    ...request,
    routePattern: parameterizePath(extractPathname(request.url)),
  }));
}

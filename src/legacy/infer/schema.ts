/**
 * apograph — JSON schema inference (Layer 3: Contracts).
 *
 * Pure deterministic logic — no LLM calls, zero token cost. Infers Zod
 * schemas from observed request/response payloads, and emits Drizzle SQLite
 * table definitions for array-returning GET endpoints.
 */

import type { RecordedRequest, EndpointCluster, InferredSchema } from '../../types.js';
import { parameterizePath } from './routes.js';

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

/** ISO 8601 date-time string (with optional milliseconds and zone). */
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Canonical UUID / GUID. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for plain JSON objects (not null, not arrays). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively infers a Zod validator string from a JavaScript value.
 * Numbers keep integer fidelity via `.int()`, strings are probed for
 * ISO date-times and UUIDs, and objects/arrays are mapped recursively.
 */
export function inferTypeFromValue(value: unknown): string {
  if (value === null) return 'z.null()';

  if (typeof value === 'string') {
    if (ISO_DATETIME_RE.test(value)) return 'z.string().datetime()';
    if (UUID_RE.test(value)) return 'z.string().uuid()';
    return 'z.string()';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'z.number().int()' : 'z.number()';
  }

  if (typeof value === 'boolean') return 'z.boolean()';

  if (Array.isArray(value)) {
    return zodArraySource(value);
  }

  if (isPlainObject(value)) {
    return zodObjectSource(shapeFromObject(value));
  }

  return 'z.unknown()';
}

/** Builds the Zod shape record for a single observed object. */
function shapeFromObject(value: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    shape[key] = inferTypeFromValue(child);
  }
  return shape;
}

/** Infers a z.array(...) source from observed array elements. */
function zodArraySource(value: unknown[]): string {
  if (value.length === 0) return 'z.array(z.unknown())';

  const objectElements = value.filter(isPlainObject);
  if (objectElements.length === value.length) {
    return `z.array(${zodObjectSource(mergeObjectShapes(objectElements))})`;
  }

  const elementTypes = new Set(value.map((element) => inferTypeFromValue(element)));
  const unified = unifyTypes(elementTypes);
  return `z.array(${unified})`;
}

/**
 * Narrows a set of differing Zod strings down to their most specific common
 * base (e.g. `z.string().uuid()` + `z.string()` -> `z.string()`).
 */
function unifyTypes(types: Set<string>): string {
  if (types.size === 0) return 'z.unknown()';
  if (types.size === 1) return firstOf(types);

  const all = [...types];
  if (all.every((t) => t.startsWith('z.string()'))) return 'z.string()';
  if (all.every((t) => t.startsWith('z.number()'))) return 'z.number()';
  if (all.every((t) => t.startsWith('z.array('))) return 'z.array(z.unknown())';
  return 'z.unknown()';
}

/** Set accessor that satisfies noUncheckedIndexedAccess. */
function firstOf(types: Set<string>): string {
  for (const type of types) return type;
  return 'z.unknown()';
}

// ---------------------------------------------------------------------------
// Shape merging
// ---------------------------------------------------------------------------

/**
 * Merges multiple observed JSON payload samples for the same route into a
 * single Zod shape. Keys present in only some samples are marked
 * `.optional()`; nested objects and arrays are merged recursively.
 */
export function mergeObjectShapes(
  samples: Record<string, unknown>[],
): Record<string, string> {
  const total = samples.length;
  const keys = new Set<string>();
  for (const sample of samples) {
    for (const key of Object.keys(sample)) keys.add(key);
  }

  const shape: Record<string, string> = {};

  for (const key of keys) {
    const present = samples.filter((sample) => key in sample);
    const values = present
      .map((sample) => sample[key])
      .filter((value): value is NonNullable<unknown> => value !== undefined);

    let type: string;

    if (values.length === 0) {
      type = 'z.unknown()';
    } else if (values.every(isPlainObject)) {
      type = zodObjectSource(mergeObjectShapes(values));
    } else if (values.every((value) => Array.isArray(value))) {
      type = zodArraySource(values.flat());
    } else {
      type = unifyTypes(new Set(values.map((value) => inferTypeFromValue(value))));
    }

    shape[key] = present.length === total ? type : `${type}.optional()`;
  }

  return shape;
}

// ---------------------------------------------------------------------------
// Source formatting
// ---------------------------------------------------------------------------

/** Renders a shape record as pretty `z.object({ ... })` source. */
function zodObjectSource(shape: Record<string, string>): string {
  const keys = Object.keys(shape);
  if (keys.length === 0) return 'z.object({})';

  const body = keys
    .map((key) => `  ${formatKey(key)}: ${indentContinuation(shape[key] ?? 'z.unknown()')}`)
    .join(',\n');

  return `z.object({\n${body}\n})`;
}

/** Quotes object keys only when they are not valid identifiers. */
function formatKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Indents continuation lines of an embedded multi-line value. */
function indentContinuation(source: string): string {
  return source
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

/**
 * Derives a PascalCase schema identifier from a route pattern and method,
 * e.g. `/api/v1/users/:id` + GET -> `ApiV1UsersIdGet`.
 */
function toPascalName(pattern: string, method: string): string {
  let name = '';

  for (const segment of pattern.split('/')) {
    if (segment.length === 0) continue;
    if (segment.startsWith(':')) {
      name += capitalize(segment.slice(1));
      continue;
    }
    for (const word of segment.split(/[^A-Za-z0-9]+/)) {
      if (word.length > 0) name += capitalize(word);
    }
  }

  name += capitalize(method.toLowerCase());

  if (!/^[A-Za-z]/.test(name)) name = `Route${name}`;
  return name.length > 0 ? name : `Route${capitalize(method.toLowerCase())}`;
}

/** Uppercases the first character of a word. */
function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

// ---------------------------------------------------------------------------
// Payload unification
// ---------------------------------------------------------------------------

/** The unified inference result for one payload side of a route. */
interface PayloadSchema {
  /** Merged Zod shape of the object (or array element) — null if none. */
  shape: Record<string, string> | null;
  /** Zod source for the payload — null if nothing could be inferred. */
  source: string | null;
}

/**
 * Unifies all observed samples of one payload side. Object samples are
 * merged directly; array-of-object samples are merged on their elements and
 * wrapped in `z.array(...)`.
 */
function buildPayloadSchema(samples: unknown[]): PayloadSchema {
  if (samples.length === 0) {
    return { shape: null, source: null };
  }

  const objectSamples = samples.filter(isPlainObject);
  if (objectSamples.length === samples.length) {
    const shape = mergeObjectShapes(objectSamples);
    return { shape, source: zodObjectSource(shape) };
  }

  const arraySamples = samples.filter(
    (sample): sample is unknown[] => Array.isArray(sample),
  );
  if (arraySamples.length === samples.length) {
    const elements = arraySamples.flat();
    const objectElements = elements.filter(isPlainObject);
    if (objectElements.length === elements.length && objectElements.length > 0) {
      const shape = mergeObjectShapes(objectElements);
      return { shape, source: `z.array(${zodObjectSource(shape)})` };
    }
    return { shape: null, source: 'z.array(z.unknown())' };
  }

  return { shape: null, source: null };
}

/** Parses a payload string into a JSON object or array, else null. */
function parseJsonPayload(text: string | null): Record<string, unknown> | unknown[] | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed) || Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
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
// Route schema inference
// ---------------------------------------------------------------------------

/**
 * Infers the contract for one endpoint cluster + HTTP method from observed
 * traffic, producing Zod source for request and/or response payloads.
 */
export function inferRouteSchema(
  requests: RecordedRequest[],
  cluster: EndpointCluster,
  method: string,
): InferredSchema {
  const targetMethod = method.toUpperCase();

  const matching = requests.filter((request) => {
    const pattern =
      request.routePattern.length > 0
        ? request.routePattern
        : parameterizePath(extractPathname(request.url));
    return pattern === cluster.pattern && request.method.toUpperCase() === targetMethod;
  });

  const requestPayload = buildPayloadSchema(
    matching
      .map((request) => parseJsonPayload(request.requestBody))
      .filter((sample): sample is Record<string, unknown> | unknown[] => sample !== null),
  );

  const responsePayload = buildPayloadSchema(
    matching
      .map((request) => parseJsonPayload(request.responseBody))
      .filter((sample): sample is Record<string, unknown> | unknown[] => sample !== null),
  );

  const name = toPascalName(cluster.pattern, targetMethod);
  const declarations: string[] = [];

  if (requestPayload.source) {
    declarations.push(
      `export const ${name}RequestSchema = ${requestPayload.source};`,
    );
  }
  if (responsePayload.source) {
    declarations.push(
      `export const ${name}ResponseSchema = ${responsePayload.source};`,
    );
  }

  const zodDefinitions =
    declarations.length > 0
      ? `import { z } from 'zod';\n\n${declarations.join('\n\n')}`
      : '';

  return {
    route: cluster.pattern,
    method: targetMethod,
    requestSchema: requestPayload.shape ?? undefined,
    responseSchema: responsePayload.shape ?? undefined,
    zodDefinitions,
  };
}

/**
 * Infers schemas for every cluster/method pair observed in the traffic,
 * sorted by route then method.
 */
export function inferAllSchemas(
  requests: RecordedRequest[],
  clusters: EndpointCluster[],
): InferredSchema[] {
  const schemas: InferredSchema[] = [];

  for (const cluster of clusters) {
    for (const method of cluster.methods) {
      schemas.push(inferRouteSchema(requests, cluster, method));
    }
  }

  return schemas.sort(
    (a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
  );
}

// ---------------------------------------------------------------------------
// Drizzle schema generation
// ---------------------------------------------------------------------------

/** Derives a snake_case table name from a route pattern. */
function deriveTableName(route: string): string {
  const segments = route
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith(':'));

  const last = segments[segments.length - 1];
  if (!last) return 'items';

  const snake = last
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

  return snake.endsWith('s') ? snake : `${snake}s`;
}

/** Converts a snake_case name to camelCase for exported constants. */
function toCamelCase(name: string): string {
  const camel = name
    .split('_')
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word : capitalize(word)))
    .join('');
  return /^[A-Za-z]/.test(camel) ? camel : `t${camel}`;
}

/** Maps a Zod shape entry to a Drizzle column definition. */
function drizzleColumn(key: string, zodType: string): string {
  const optional = zodType.endsWith('.optional()');
  const base = optional ? zodType.slice(0, -'.optional()'.length) : zodType;

  const column = formatKey(key);

  let type: string;
  if (base === 'z.number().int()') {
    type = `integer(${JSON.stringify(column)})`;
  } else if (base === 'z.number()') {
    type = `real(${JSON.stringify(column)})`;
  } else if (base === 'z.boolean()') {
    type = `integer(${JSON.stringify(column)}, { mode: 'boolean' })`;
  } else {
    type = `text(${JSON.stringify(column)})`;
  }

  const isPrimaryKey = !optional && (key === 'id' || key === '_id');
  if (isPrimaryKey) return `${formatKey(key)}: ${type}.primaryKey()`;

  return `${formatKey(key)}: ${type}${optional ? '' : '.notNull()'}`;
}

/**
 * Emits a Drizzle SQLite schema for GET endpoints whose responses are
 * arrays of objects. Each such endpoint becomes one `sqliteTable(...)`:
 * `z.string()` -> `text()`, `z.number().int()` -> `integer()`,
 * `z.number()` -> `real()`, `z.boolean()` -> `integer({ mode: 'boolean' })`.
 * Returns an empty string when no qualifying endpoints exist.
 */
export function generateDrizzleSchema(schemas: InferredSchema[]): string {
  const tables: string[] = [];

  for (const schema of schemas) {
    if (schema.method !== 'GET') continue;
    if (!schema.zodDefinitions.includes('ResponseSchema = z.array(z.object({')) {
      continue;
    }
    const shape = schema.responseSchema;
    if (!shape || Object.keys(shape).length === 0) continue;

    const tableName = deriveTableName(schema.route);
    const constName = toCamelCase(tableName);

    const columns = Object.entries(shape)
      .map(([key, zodType]) =>
        drizzleColumn(key, typeof zodType === 'string' ? zodType : 'z.unknown()'),
      )
      .join(',\n  ');

    tables.push(
      `export const ${constName} = sqliteTable(${JSON.stringify(tableName)}, {\n  ${columns},\n});`,
    );
  }

  if (tables.length === 0) return '';

  return `import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';\n\n${tables.join('\n\n')}\n`;
}

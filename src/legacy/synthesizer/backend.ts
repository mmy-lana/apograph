/**
 * apograph — Backend synthesis (Layer 5: Orchestration).
 *
 * Generates the database layer deterministically (better-sqlite3 + Drizzle,
 * zero AI tokens) and prompts the LLM for a Hono API server matching the
 * inferred endpoint contracts.
 */

import type { InferredSchema, ProjectFile } from '../../types.js';
import { generateDrizzleSchema } from '../infer/schema.js';
import { generateStructuredFiles } from '../../synthesizer/llm.js';

// ---------------------------------------------------------------------------
// Deterministic database files
// ---------------------------------------------------------------------------

/** Deterministically emits the shared Drizzle + better-sqlite3 client. */
export function generateDbClientFile(): ProjectFile {
  const content = [
    "import Database from 'better-sqlite3';",
    "import { drizzle } from 'drizzle-orm/better-sqlite3';",
    '',
    "const sqlite = new Database('sqlite.db');",
    'sqlite.pragma("journal_mode = WAL");',
    '',
    'export const db = drizzle(sqlite);',
    '',
    'export default db;',
  ].join('\n');

  return { path: 'src/db/index.ts', content };
}

/** Fallback schema content when no tables could be inferred. */
const FALLBACK_SCHEMA = [
  "import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';",
  '',
  '/** Fallback table — no array-of-object GET endpoints were observed in the harvest. */',
  'export const items = sqliteTable("items", {',
  '  id: integer("id").primaryKey(),',
  '  createdAt: text("createdAt").notNull(),',
  '  data: text("data", { mode: "json" }).notNull(),',
  '});',
  '',
  'export type Item = typeof items.$inferSelect;',
  'export type NewItem = typeof items.$inferInsert;',
  '',
].join('\n');

/** Deterministically emits the Drizzle schema from inferred contracts. */
export function generateDrizzleSchemaFile(schemas: InferredSchema[]): ProjectFile {
  const generated = generateDrizzleSchema(schemas);

  const content =
    generated.length > 0
      ? generated
      : FALLBACK_SCHEMA;

  return { path: 'src/db/schema.ts', content };
}

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

/**
 * Serializes inferred endpoint contracts into a concise API specification:
 * route, method, and the generated Zod definitions for request/response.
 */
export function formatSchemasForPrompt(schemas: InferredSchema[]): string {
  if (schemas.length === 0) {
    return '(no endpoint contracts were inferred from the harvest)';
  }

  const sections = schemas.map((schema) => {
    return [
      `### ${schema.method} ${schema.route}`,
      schema.zodDefinitions.length > 0 ? schema.zodDefinitions : '(no payload schemas)',
    ].join('\n');
  });

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** System prompt guiding the backend synthesis model. */
const SYSTEM_GUIDELINES = [
  'You are an expert backend engineer synthesizing an API server from inferred endpoint contracts.',
  'Rules:',
  '1. Framework: Hono (v4+) running on Node.js via @hono/node-server.',
  '2. Register the cors() and logger() middlewares on the app.',
  '3. Database: import { db } from "./db/index.js" and the table definitions from "./db/schema.js" — never re-create the client or schema.',
  '4. Contracts: validate every incoming request body against the provided inferred Zod schemas before touching the database.',
  '5. Handlers execute CRUD queries against the Drizzle SQLite tables (select/insert/update/delete).',
  '6. Emit these files exactly:',
  '   - src/index.ts — Hono application entrypoint: middlewares, route mounting, and serve({ fetch: app.fetch, port: 3000 }).',
  '   - src/routes/api.ts — the route handlers implementing every endpoint from the specification.',
  '7. Every file must be complete and compile-ready — no placeholders, no TODOs, no truncation.',
  '8. Do NOT generate src/db/index.ts or src/db/schema.ts — they are provided deterministically.',
].join('\n');

/**
 * Synthesizes the backend project files: the LLM generates the Hono server
 * and route handlers from the inferred contracts, and the deterministic
 * database client and schema files are merged into the result.
 */
export async function synthesizeBackend(
  schemas: InferredSchema[],
): Promise<ProjectFile[]> {
  const prompt = [
    'Synthesize a Hono API server from the following inferred endpoint contracts.',
    '',
    '# API Specification',
    formatSchemasForPrompt(schemas),
    '',
    'Generate src/index.ts and src/routes/api.ts.',
  ].join('\n');

  const generatedFiles = await generateStructuredFiles(prompt, SYSTEM_GUIDELINES);

  const deterministicFiles: ProjectFile[] = [
    generateDbClientFile(),
    generateDrizzleSchemaFile(schemas),
  ];

  // Strip any LLM-emitted duplicates of the deterministic paths before merging.
  const deterministicPaths = new Set(deterministicFiles.map((file) => file.path));
  const llmFiles = generatedFiles.filter((file) => !deterministicPaths.has(file.path));

  return [...llmFiles, ...deterministicFiles];
}

/**
 * Generated-source sanitizer tests (generic apostrophe-in-string repair).
 *
 * Vision synthesis emits page copy as single-quoted TypeScript string literals.
 * When that copy contains an apostrophe ("you'll", "month's") the unescaped
 * quote terminates the literal early and the rest of the sentence parses as
 * code (TS1005). `escapeSingleQuotedApostrophes` repairs this deterministically
 * without touching double-quoted strings, template literals, or JSX text.
 *
 * spec: src/emitter/sanitize.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeSingleQuotedApostrophes } from '../dist/emitter/sanitize.js';

test('sanitizer > escapes intra-word apostrophes inside single-quoted literals', () => {
  const src = `const items = [{ text: 'you'll see the credit on month's bill' }];`;
  const out = escapeSingleQuotedApostrophes(src);
  assert.equal(out, `const items = [{ text: 'you\\'ll see the credit on month\\'s bill' }];`);
});

test('sanitizer > leaves JSX text apostrophes untouched (no visible backslashes)', () => {
  const src = `const el = <p>Don't miss Apple's deals</p>;`;
  assert.equal(escapeSingleQuotedApostrophes(src), src);
});

test('sanitizer > leaves double-quoted string apostrophes untouched', () => {
  const src = `const s = "it's a 'test' string";`;
  assert.equal(escapeSingleQuotedApostrophes(src), src);
});

test('sanitizer > leaves template literal apostrophes untouched', () => {
  const src = 'const s = `you\'ll love it`;';
  assert.equal(escapeSingleQuotedApostrophes(src), src);
});

test('sanitizer > is a no-op on well-formed literals without apostrophes', () => {
  const src = `const a = 'hello world'; const b = 'a, b; c)';`;
  assert.equal(escapeSingleQuotedApostrophes(src), src);
});

test('sanitizer > closes a literal at punctuation and keeps trailing code intact', () => {
  const src = `text: 'roll with it', next: 'value',`;
  const out = escapeSingleQuotedApostrophes(src);
  assert.equal(out, `text: 'roll with it', next: 'value',`);
});

test('sanitizer > preserves escaped quotes already present', () => {
  const src = `const s = 'already \\'escaped\\' text';`;
  assert.equal(escapeSingleQuotedApostrophes(src), src);
});

test('sanitizer > handles apostrophes adjacent to spaces inside a literal', () => {
  const src = `text: 'the rock 'n roll show',`;
  const out = escapeSingleQuotedApostrophes(src);
  // interior leading-apostrophe word must not close the literal
  assert.ok(out.includes("rock \\'n roll"), `unexpected: ${out}`);
  assert.ok(out.trimEnd().endsWith("',"), `literal should still close: ${out}`);
});

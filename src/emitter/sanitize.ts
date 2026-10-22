/**
 * apograph — deterministic generated-source sanitizer.
 *
 * Vision synthesis emits page data as single-quoted TypeScript string literals
 * (e.g. `text: '…you'll see…'`). When the captured prose contains an apostrophe
 * the literal is written unescaped, so the `'` terminates the string early and
 * the remainder of the sentence is parsed as code — surfacing as a cascade of
 * `TS1005 "',' expected"` / `"':' expected"` syntax errors on one very long line.
 *
 * This is a generic, target-agnostic defect: any site whose copy contains an
 * apostrophe ("you'll", "month's", "Apple's") triggers it. The fix is likewise
 * generic: escape apostrophes that appear *inside* a single-quoted string
 * literal while leaving every other quote context untouched.
 *
 * The scanner is a minimal TypeScript/JSX lexer with these states:
 *   - normal: JSX text, identifiers, punctuation
 *   - string: single-quoted, double-quoted, and template literals
 *   - comment: line (`//`) and block (`/* *\/`)
 *
 * Only single-quoted literals are rewritten. Double-quoted and template
 * literals already accept raw apostrophes, and JSX text must not gain visible
 * backslashes, so those are copied through verbatim. This keeps the transform
 * safe to run over every emitted source file.
 */

const STRING_START_CHARS = new Set([':', '=', '(', '[', ',', '{']);

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Escapes apostrophes that occur inside single-quoted string literals so the
 * literals remain well-formed. Every other context (double-quoted strings,
 * template literals, JSX text, comments) is returned unchanged.
 */
export function escapeSingleQuotedApostrophes(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  // Index of the last non-whitespace character already emitted to `out`.
  let lastMeaningful = '';

  while (i < n) {
    const ch = source[i] as string;

    // Comments -------------------------------------------------------------
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        out += source[i];
        i++;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i];
        i++;
      }
      if (i < n) {
        out += '*/';
        i += 2;
      }
      continue;
    }

    // Double-quoted and template literals: copy through verbatim ------------
    if (ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += source[i];
          i++;
          break;
        }
        out += source[i];
        i++;
      }
      lastMeaningful = quote;
      continue;
    }

    // Single-quoted literal or apostrophe ----------------------------------
    if (ch === "'") {
      const prevWord = isWordChar(source[i - 1]);
      const nextWord = isWordChar(source[i + 1]);

      // An intra-word apostrophe in normal code (JSX text like "Don't") is
      // never a delimiter and must be preserved.
      // A quote opens a literal only in a value/start position.
      const opensLiteral = !prevWord && STRING_START_CHARS.has(lastMeaningful);

      if (!opensLiteral) {
        out += ch;
        i++;
        lastMeaningful = ch;
        continue;
      }

      // Enter the single-quoted literal: copy the opening quote.
      out += ch;
      i++;
      while (i < n) {
        const d = source[i];
        if (d === '\\') {
          out += d + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (d === "'") {
          // An apostrophe followed by a word character is interior prose
          // ("you'll", "month's", "rock 'n roll") — escape it. Otherwise it is
          // the closing quote of the literal.
          if (isWordChar(source[i + 1])) {
            out += "\\'";
            i++;
            continue;
          }
          out += d;
          i++;
          break;
        }
        out += d;
        i++;
      }
      lastMeaningful = "'";
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) lastMeaningful = ch;
    i++;
  }

  return out;
}

# Reference Spec: Webcrack Bundle Unpacking

**Purpose (Layer 2 — Reconstruction):** Unpack bundled/minified JavaScript into
readable modules and de-obfuscate identifiers. This spec is the canonical minimal
shape for the reconstruction engine.

## Minimal Snippet

```ts
import { webcrack } from 'webcrack';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// bundledCode is the raw JS bundle text harvested by Layer 1 (HarvestedSession.scripts)
const bundledCode = '...';

const result = await webcrack(bundledCode);

// result.code      — de-obfuscated bundle (single-file mode)
// result.bundle    — module graph (present when webpack/browserify unpacking succeeds)

if (result.bundle) {
  for (const [id, module] of result.bundle.modules) {
    const filePath = join('output', `module-${id}.js`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, module.code, 'utf8');
    console.log(`unpacked module ${id} -> ${filePath} (${module.code.length} bytes)`);
  }
} else {
  await mkdir('output', { recursive: true });
  await writeFile(join('output', 'deobfuscated.js'), result.code, 'utf8');
}
```

## Contract Notes

- `webcrack(bundledCode)` is fully programmatic (no CLI required) and returns:
  - `code`: de-obfuscated source string,
  - `bundle`: an optional `Bundle` whose `modules` is an iterable of
    `[id, { code, ... }]` entries.
- Unpacking `0.webpack`-style bundles yields `UnpackedModule[]` records
  (`path`, `rawCode`, `exports`) in the canonical types.
- Identifier de-obfuscation (hex names like `_0x4f2a` → readable names) runs as a
  post-pass over the unpacked modules via AST rewriting; not part of this snippet.

## Verification

```bash
node --input-type=module -e "import('webcrack').then(w => console.log(typeof w.webcrack))"
```

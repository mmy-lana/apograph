# Reference Spec: CSSTree Design-Token Extraction

**Purpose (Layer 4 — UI & Design System):** Parse stylesheets into an AST and
extract design tokens (colors, font sizes, border radii) that feed
`DesignTokens` in `src/types.ts`.

## Minimal Snippet

```ts
import * as csstree from 'css-tree';

const css = `
  .btn {
    color: #3b82f6;
    background-color: rgb(59, 130, 246);
    font-size: 14px;
    border-radius: 8px;
  }
`;

const colors = new Set<string>();
const fontSizes = new Set<string>();
const radii = new Set<string>();

const ast = csstree.parse(css);

csstree.walk(ast, (node) => {
  if (node.type === 'Declaration') {
    const property = csstree.property(node.property).name;
    const value = csstree.generate(node.value);

    if (property === 'color' || property === 'background-color' || property === 'border-color') {
      colors.add(value);
    } else if (property === 'font-size') {
      fontSizes.add(value);
    } else if (property === 'border-radius') {
      radii.add(value);
    }
  }
});

console.log({
  colors: [...colors],        // ['#3b82f6', 'rgb(59,130,246)']
  fontSizes: [...fontSizes],  // ['14px']
  radii: [...radii],          // ['8px']
});
```

## Contract Notes

- `csstree.parse(css)` produces a CST; `csstree.walk(ast, fn)` visits every node.
- Declarations are matched by property name via `csstree.property(...)` (handles
  vendor prefixes) and serialized with `csstree.generate(node.value)`.
- Extracted token sets seed Tailwind theme generation (Layer 4 output step).

## Verification

```bash
node --input-type=module -e "import('css-tree').then(c => console.log(typeof c.parse, typeof c.walk))"
```

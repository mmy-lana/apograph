# Reference Spec: MCP SDK Server & Tool Registration

**Purpose (Layer 5 — Agent Orchestrator):** Expose apograph capabilities
(harvest, unpack, infer contracts, synthesize) as Model Context Protocol tools
so external LLM agents can drive the pipeline.

## Minimal Snippet

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'apograph', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.tool(
  'harvest_session',
  'Capture network traffic and a11y snapshots for a target URL',
  { targetUrl: z.string().url() },
  async ({ targetUrl }) => {
    // Layer 1 invocation goes here in a later step
    return {
      content: [{ type: 'text', text: `harvest queued: ${targetUrl}` }],
    };
  }
);

server.tool(
  'synthesize_project',
  'Generate a full project tree from a harvested session',
  { sessionId: z.string().uuid() },
  async ({ sessionId }) => {
    // Layer 5 synthesis invocation goes here in a later step
    return {
      content: [{ type: 'text', text: `synthesis queued: ${sessionId}` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Contract Notes

- `McpServer` + `server.tool(name, description, zodShape, handler)` is the
  high-level registration API; the Zod schema doubles as the tool's
  JSON-Schema input definition.
- `StdioServerTransport` is the default local transport; an HTTP/SSE transport
  can be swapped in without changing tool registrations.
- Handlers return `{ content: [{ type: 'text', text }] }` — richer content
  types (resources, structured JSON) follow the same envelope.

## Verification

```bash
node --input-type=module -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log(typeof m.McpServer))"
```

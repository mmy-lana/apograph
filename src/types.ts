/**
 * apograph — Canonical domain models (Layers 1–5).
 *
 * All layers cross-reference through this single module, so layer types never
 * import from each other and circular imports are structurally impossible.
 */

// ---------------------------------------------------------------------------
// Layer 1 — Capture
// ---------------------------------------------------------------------------

/** A single harvested HTTP exchange (request + response pair). */
export interface RecordedRequest {
  method: string;
  url: string;
  /** Route pattern (e.g. `/api/users/:id`) inferred at capture time, if known. */
  routePattern: string;
  headers: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  status: number;
  timestamp: number;
}

/** A WebSocket frame observed on a live socket. */
export interface WebSocketFrame {
  direction: 'in' | 'out';
  payload: string | Record<string, unknown>;
  timestamp: number;
}

/** A replayable user interaction. */
export interface InteractionEvent {
  type: 'click' | 'input' | 'navigate';
  selector: string;
  value?: string;
  timestamp: number;
}

/** The complete output of one capture session. */
export interface HarvestedSession {
  id: string;
  targetUrl: string;
  requests: RecordedRequest[];
  socketFrames: WebSocketFrame[];
  events: InteractionEvent[];
  /** Raw script sources harvested from the page (input to Layer 2). */
  scripts: string[];
}

// ---------------------------------------------------------------------------
// Layer 2 — Reconstruction
// ---------------------------------------------------------------------------

/** A single module recovered from an unpacked bundle. */
export interface UnpackedModule {
  path: string;
  rawCode: string;
  astType?: string;
  exports: string[];
}

/** The result of unpacking + de-obfuscating one harvested bundle. */
export interface DecompiledBundle {
  bundleName: string;
  modules: UnpackedModule[];
}

// ---------------------------------------------------------------------------
// Layer 3 — Contract Inference
// ---------------------------------------------------------------------------

/** A cluster of observed URLs that share a common route pattern. */
export interface EndpointCluster {
  pattern: string;
  sampleUrls: string[];
  methods: string[];
}

/** An inferred API contract for one endpoint, with generated Zod code. */
export interface InferredSchema {
  route: string;
  method: string;
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  /** Generated Zod definition source code for runtime validation. */
  zodDefinitions: string;
}

// ---------------------------------------------------------------------------
// Layer 4 — UI & Design System
// ---------------------------------------------------------------------------

/** One node of the accessibility tree (mirrors Playwright's AxNode shape). */
export interface A11yNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: A11yNode[];
}

/** Design tokens extracted from stylesheets. */
export interface DesignTokens {
  colors: Record<string, string>;
  fonts: string[];
  spacing: string[];
  radii: string[];
}

/** A UI snapshot for one route: a11y tree plus extracted design tokens. */
export interface DOMSnapshot {
  route: string;
  a11yTree: A11yNode;
  tokens: DesignTokens;
}

// ---------------------------------------------------------------------------
// Layer 5 — Orchestration & Output
// ---------------------------------------------------------------------------

/** A single synthesized file in an output project. */
export interface ProjectFile {
  path: string;
  content: string;
}

/** The full synthesized project tree. */
export interface ProjectTree {
  files: ProjectFile[];
}

/** Everything the synthesis engine needs for one run. */
export interface SynthesisTask {
  session: HarvestedSession;
  snapshots: DOMSnapshot[];
  schemas: InferredSchema[];
  bundles: DecompiledBundle[];
}

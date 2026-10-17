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
// Layer 1b — Headless evidence crawl
// ---------------------------------------------------------------------------

/** Which viewports to capture during a crawl / verification run. */
export type ViewportMode = 'both' | 'desktop' | 'mobile';

/** Crawl scope applied to same-origin link discovery. */
export type CrawlScope = 'single' | 'subtree' | 'site';

/** SEO / social metadata extracted from a page's <head>. */
export interface RouteMetadata {
  title?: string;
  description?: string;
  favicon?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
}

/**
 * One hash-anchor sub-capture recorded on a route (SPA-aware crawl): the
 * crawler scrolled to the `a[href^="#"]` target and screenshotted the
 * resting state, without creating a new route entry.
 */
export interface HashCapture {
  /** The hash target as it appeared in the anchor (e.g. `#pricing`). */
  hash: string;
  /** Local path of the desktop screenshot PNG of the scrolled state. */
  screenshot: string;
}

/**
 * One modal / overlay state discovered by interactively probing a page's
 * clickable elements (SPA-aware crawl).
 */
export interface ModalCapture {
  /** Readable selector of the element whose click revealed the overlay. */
  triggerSelector: string;
  /** Accessible name of the modal (aria-label / aria-labelledby / heading). */
  modalName: string;
  /** Local path of the desktop screenshot PNG (null when not captured). */
  desktopScreenshot: string | null;
  /** Local path of the mobile screenshot PNG (null when not captured). */
  mobileScreenshot: string | null;
}

/** One crawled page's recorded evidence. */
export interface CrawlRoute {
  /** The normalized URL of the page. */
  url: string;
  /** URL path of the page (e.g. `/about`). */
  path: string;
  /** Document title at capture time. */
  title: string;
  /** Local path of the desktop (1280x800) screenshot PNG (null when not captured). */
  desktopScreenshot: string | null;
  /** Local path of the mobile (390x844) screenshot PNG (null when not captured). */
  mobileScreenshot: string | null;
  /** SEO / OpenGraph metadata extracted from the page head. */
  metadata?: RouteMetadata;
  /** Accessibility tree extracted at capture time. */
  a11yTree: A11yNode;
  /** Design tokens extracted at capture time. */
  tokens: DesignTokens;
  /** Visible text corpus harvested in document order (spec s5.1). */
  textSpans?: TextSpan[];
  /**
   * Hash-anchor sub-captures (`#section` targets) recorded on this route
   * without creating new route entries. Optional: older evidence bundles
   * predate SPA-aware capture.
   */
  hashCaptures?: HashCapture[];
  /**
   * Modal / overlay states discovered by interactive probing. Optional:
   * older evidence bundles predate SPA-aware capture.
   */
  modalCaptures?: ModalCapture[];
}

/** Lifecycle status of one mirrored asset. */
export type AssetStatus = 'downloaded' | 'failed' | 'external';

/** One entry in the asset manifest. */
export interface AssetEntry {
  originalUrl: string;
  /** Local file path, or null when not mirrored (external / failed). */
  localPath: string | null;
  status: AssetStatus;
  /** MIME type as reported by the download response, when known. */
  mimeType?: string;
  /** Provenance: URL mirror vs screenshot-cropped visual extract. */
  kind?: 'mirrored' | 'visual-extract';
  /** Human-readable role hint for visual extracts (e.g. 'hero-bg'). */
  suggestedName?: string;
  /** Route paths where this asset was encountered. */
  routes?: string[];
}

/** Why a visually distinct region was selected for extraction. */
export type VisualAssetKind = 'background-image' | 'canvas' | 'svg' | 'image';

/**
 * A significant visual surface cropped out of a full-page screenshot:
 * a CSS `background-image` url() element (never gradients), a `<canvas>`, a
 * >=48px `<svg>` diagram, or a loaded `<img>` the DOM scraper could not
 * mirror (blob:/data: URLs). Generic wrapper divs are never cropped for size
 * alone.
 */
export interface VisualAssetRegion {
  kind: VisualAssetKind;
  /** Page-space bounding box in CSS pixels at capture time. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source element tag name (lowercase). */
  tag: string;
  /** Element id, when present. */
  id: string | null;
  /** aria-label, when present. */
  ariaLabel: string | null;
  /** Image alt text, when present. */
  alt: string | null;
  /** Raw class tokens (utility-class tokens are never used for naming). */
  classTokens: string[];
  /** True when inside `#hero` or the top edge is within 600px of the page top. */
  inHero: boolean;
}

/** A URL the crawler chose not to visit, with the reason. */
export interface SkippedUrl {
  url: string;
  reason: string;
}

/** A URL whose navigation failed, with the error reason. */
export interface FailedNavigation {
  url: string;
  reason: string;
}

/** A resource that could not be captured into the evidence bundle. */
export interface UncapturedResource {
  url: string;
  reason: string;
}

/**
 * An instant client-side redirect aliased during crawl (spec s2.2): the
 * initial URL never becomes a route; generated configs redirect it to `to`.
 */
export interface RedirectAliasRecord {
  from: string;
  to: string;
  /** Settle time in ms between navigation commit and final URL stability. */
  settleTimeMs: number;
}

/** Crawl problems recorded for the manifest's diagnostics section. */
export interface CrawlDiagnostics {
  skippedUrls: SkippedUrl[];
  failedNavigations: FailedNavigation[];
  uncapturedResources: UncapturedResource[];
  /** Instant redirect aliases recorded instead of dead transition frames. */
  redirectAliases: RedirectAliasRecord[];
}

/** Aggregate statistics for one crawl run. */
export interface CrawlStats {
  pagesCrawled: number;
  linksDiscovered: number;
  assetsDownloaded: number;
  assetsFailed: number;
  externalAssets: number;
  durationMs: number;
}

/** The full evidence bundle manifest written to `.apograph/evidence/manifest.json`. */
export interface EvidenceManifest {
  targetUrl: string;
  /** ISO-8601 timestamp of the crawl. */
  crawledAt: string;
  stats: CrawlStats;
  routes: CrawlRoute[];
  assets: AssetEntry[];
  diagnostics: CrawlDiagnostics;
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

/** One visible text span harvested from the DOM (spec s5.1). */
export interface TextSpan {
  /** Trimmed visible text content. */
  text: string;
  /** Verbatim gradient definition for gradient text (background-image). */
  gradient?: string;
  /** Computed text color (e.g. `rgb(6, 182, 212)`). */
  color: string;
  /** Element tag holding the text (e.g. `span`). */
  tag: string;
  /** Nearest semantic ancestor tag (e.g. `h1`), else the parent tag. */
  parentTag: string;
  /** Bounding box in CSS pixels at capture time. */
  boundingBox?: { top: number; left: number; width: number; height: number };
}

/** One node of the accessibility tree (mirrors Playwright's AxNode shape). */
export interface A11yNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: A11yNode[];
}

/** Computed canvas colors of `document.body` at capture time (spec s4.1). */
export interface CanvasTheme {
  /** Computed body background color, normalized to `#rrggbb`. */
  backgroundColor: string;
  /** Computed body foreground color, normalized to `#rrggbb`. */
  color?: string;
}

/** Design tokens extracted from stylesheets. */
export interface DesignTokens {
  colors: Record<string, string>;
  fonts: string[];
  spacing: string[];
  radii: string[];
  /** Computed `document.body` canvas colors (spec s4.1). */
  canvas?: CanvasTheme;
}

/** A UI snapshot for one route: a11y tree plus extracted design tokens. */
export interface DOMSnapshot {
  route: string;
  a11yTree: A11yNode;
  tokens: DesignTokens;
  /** Visible text corpus harvested in document order (spec s5.1). */
  textSpans?: TextSpan[];
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

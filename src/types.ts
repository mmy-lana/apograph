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
   * The same visible text corpus measured at the mobile capture viewport.
   * Optional: older evidence bundles predate per-viewport measurement and
   * single-viewport crawls capture one corpus only.
   */
  mobileTextSpans?: TextSpan[];
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
  /** Rendered overlay semantics of a captured <canvas> surface, when known. */
  canvasOverlay?: CanvasOverlayMeta;
}

/**
 * How a captured <canvas> surface renders in the source page (measured from
 * computed styles at capture time): effects layers replay as fixed
 * full-viewport overlays at the captured opacity, while content canvases
 * (charts, maps) render inline in the layout.
 */
export interface CanvasOverlayMeta {
  /** Computed `opacity` of the canvas element at capture time. */
  opacity: number;
  /** Computed `position` of the canvas element (e.g. `fixed`). */
  position: string;
  /** True when the canvas box covers >=90% of the viewport in both axes. */
  coversViewport: boolean;
  /** Whether the asset holds the canvas's own drawing or a screenshot crop. */
  source: 'element-buffer' | 'screenshot-crop';
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
  /** For canvas regions: the element's own drawing as a PNG data URL, when readable. */
  canvasDataUrl?: string;
  /** For canvas regions: measured overlay semantics (opacity/position/coverage). */
  canvasOverlay?: CanvasOverlayMeta;
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

/**
 * Lightweight per-route descriptor stored in the root `manifest.json` index of
 * a modular evidence bundle. Heavy payloads (a11y tree, text spans, tokens,
 * captures) live in `routes/<slug>/` and are hydrated on demand.
 */
export interface RouteManifestIndex {
  /** URL path of the page (e.g. `/about`) — canonical route key. */
  path: string;
  /** The normalized URL of the page. */
  url: string;
  /** Document title at capture time. */
  title: string;
  /** Filesystem-safe subdirectory slug under `routes/`. */
  slug: string;
  /** Local path of the desktop (1280x800) screenshot PNG (null when not captured). */
  desktopScreenshot: string | null;
  /** Local path of the mobile (390x844) screenshot PNG (null when not captured). */
  mobileScreenshot: string | null;
}

/** Payload of `routes/<slug>/text-spans.json` in a modular evidence bundle. */
export interface ModularTextSpans {
  desktop: TextSpan[];
  mobile?: TextSpan[];
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

/**
 * Measured computed typography of a text span at capture time (rendered
 * ground truth for synthesis replay). Optional fields mirror the CSS
 * computed-style properties that were resolvable; older evidence bundles
 * predate typography capture.
 */
export interface TextStyle {
  /** Computed `font-size` in CSS pixels (e.g. `30px`). */
  fontSize?: string;
  /** Computed `font-weight` (e.g. `900`). */
  fontWeight?: string;
  /** Computed `line-height` in CSS pixels when resolvable. */
  lineHeight?: string;
  /** Computed `letter-spacing` when not `normal`. */
  letterSpacing?: string;
  /** Computed `text-transform` when not `none`. */
  textTransform?: string;
  /** Computed `font-family` (first family in the stack). */
  fontFamily?: string;
  /** Computed `text-align`. */
  textAlign?: string;
}

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
  /** Measured computed typography at capture time (rendered ground truth). */
  style?: TextStyle;
  /**
   * `href` of the nearest ancestor anchor, verbatim as authored (e.g.
   * `https://example.com/x`, `mailto:a@b.c`, `/about`). Absent when the span
   * does not render inside a link — synthesizers must never invent one.
   */
  href?: string;
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

/** One captured `@font-face` rule (webfont replay evidence). */
export interface FontFaceRule {
  /** Font family name without quotes. */
  family: string;
  /** `src` descriptor value (contains the remote/local font source URLs). */
  src: string;
  /** `font-weight` descriptor value (e.g. `400`, `100 900`). */
  weight?: string;
  /** `font-style` descriptor value (e.g. `normal`). */
  style?: string;
}

/** Design tokens extracted from stylesheets. */
export interface DesignTokens {
  colors: Record<string, string>;
  fonts: string[];
  spacing: string[];
  radii: string[];
  /** Computed `document.body` canvas colors (spec s4.1). */
  canvas?: CanvasTheme;
  /** Captured `@font-face` rules (webfont replay evidence). */
  fontFaces?: FontFaceRule[];
  /** Captured font-related custom properties (e.g. `--font-sans`). */
  fontVariables?: Record<string, string>;
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

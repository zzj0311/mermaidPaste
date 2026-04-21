import mermaid from 'mermaid';

type Theme = 'default' | 'dark' | 'neutral' | 'forest';

interface RenderInput {
  code: string;
  scale: number;
  theme: Theme;
  /**
   * When true (default), mermaid renders flowchart labels inside
   * <foreignObject> so HTML like <br/> works. When false, labels are plain
   * SVG <text> — uglier for some cases but survives Inkscape's EMF export
   * (which ignores foreignObject entirely).
   */
  htmlLabels?: boolean;
  /**
   * If true, only produce the SVG string — don't inject it into the DOM.
   * Used for the EMF-only pass, which feeds Inkscape and never gets
   * captured via webContents.capturePage.
   */
  skipDomInject?: boolean;
  /**
   * Flatten all CSS into per-element inline styles AND mirror key properties
   * (fill/stroke/font-*) as SVG attributes. Required for Inkscape's EMF
   * exporter, whose CSS selector resolution is too weak to apply mermaid's
   * class-based stylesheet — without this flattening, text disappears and
   * nodes fall back to black fill.
   */
  inlineStyles?: boolean;
  /**
   * Bake nested <g transform> into each leaf element's own transform, collapse
   * nested <tspan> text layout into absolute x/y on a single <text>, and
   * replace marker-end arrowheads with inline <polygon>s. Visio's SVG importer
   * mishandles all three of these, so we normalise them away for the SVG file
   * we put on the clipboard as CF_HDROP.
   */
  flattenForVisio?: boolean;
}

interface RenderOk {
  svg: string;
  width: number;
  height: number;
}

interface RenderErr {
  error: string;
  svg?: string;
}

const MAX_DIMENSION = 8192;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Patches raw mermaid SVG text so it's safe as an XML payload.
 *
 *   1. Tolerant parse via text/html (accepts bare <br>, unclosed <hr>, etc.
 *      that mermaid emits inside <foreignObject> HTML labels — those are valid
 *      HTML but invalid XML).
 *   2. Re-serialize the <svg> subtree via XMLSerializer so void HTML elements
 *      come back as proper XML (`<br/>`, `<hr/>`, …).
 *   3. Force explicit width/height/xmlns/viewBox on the root element.
 */
function normalizeSvg(svgText: string): { svg: string; width: number; height: number } {
  let root: Element | null = null;

  const xmlDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const xmlErr = xmlDoc.querySelector('parsererror');
  if (!xmlErr && xmlDoc.documentElement.nodeName.toLowerCase() === 'svg') {
    root = xmlDoc.documentElement;
  } else {
    if (xmlErr) {
      console.warn(
        '[renderer] strict XML parse failed, falling back to HTML-tolerant parse:',
        xmlErr.textContent?.split('\n').slice(0, 2).join(' | ')
      );
    }
    const htmlDoc = new DOMParser().parseFromString(svgText, 'text/html');
    root = htmlDoc.querySelector('svg');
    if (!root) {
      console.warn('[renderer] HTML parse did not yield an <svg> root');
      return { svg: patchHtmlVoidTags(svgText), width: 1024, height: 768 };
    }
  }

  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);
  if (!root.getAttribute('xmlns:xlink')) {
    root.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }

  let w = parseFloat(root.getAttribute('width') || '');
  let h = parseFloat(root.getAttribute('height') || '');
  const vb = root.getAttribute('viewBox');
  if ((!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) && vb) {
    const parts = vb.split(/[\s,]+/).map(parseFloat);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      w = parts[2];
      h = parts[3];
    }
  }
  if (!Number.isFinite(w) || w <= 0) w = 1024;
  if (!Number.isFinite(h) || h <= 0) h = 768;

  root.setAttribute('width', String(w));
  root.setAttribute('height', String(h));
  if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${w} ${h}`);

  let serialized = new XMLSerializer().serializeToString(root);
  serialized = patchHtmlVoidTags(serialized);
  return { svg: serialized, width: w, height: h };
}

/**
 * Keep this list small on purpose — every extra property written to every
 * element bloats the SVG and slows down Inkscape. These are the properties
 * whose absence causes the "invisible text / black boxes" failure mode.
 */
const INLINE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'color',
  'opacity',
  'visibility',
  'display',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'white-space',
] as const;

/** Subset of the above that Inkscape reads more reliably as SVG attributes
 *  than as CSS. We write both — the SVG attribute AND the inline style. */
const ATTR_MIRROR = new Set<string>([
  'fill',
  'stroke',
  'stroke-width',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
]);

/**
 * Values we skip writing because they're the CSS default and add noise.
 * Critically, this lets us drop `visibility: visible` (the default from an
 * off-screen scratch container) so we don't accidentally pin every element
 * as visible when it shouldn't matter — and conversely, we never need to
 * write a `visibility: hidden` the container accidentally inherited.
 */
const SKIP_IF_VALUE: Record<string, string[]> = {
  'fill-opacity': ['1'],
  'stroke-opacity': ['1'],
  'opacity': ['1'],
  'visibility': ['visible'],
  'display': ['inline', 'block', 'inline-block'],
  'stroke-linecap': ['butt'],
  'stroke-linejoin': ['miter'],
  'stroke-dasharray': ['none'],
  'font-style': ['normal'],
  'font-weight': ['400', 'normal'],
  'dominant-baseline': ['auto'],
  'alignment-baseline': ['auto'],
  'white-space': ['normal'],
};

/**
 * Inject an SVG string into an offscreen <div> attached to document.body so
 * getComputedStyle works, walk every descendant, and write out both inline
 * `style="…"` and key SVG attributes (fill/stroke/font-*) carrying each
 * element's resolved style. Finally strip `<style>` blocks from the SVG so
 * Inkscape isn't tempted to re-parse the original CSS.
 *
 * Returns the flattened SVG string. The scratch container is removed after.
 */
function inlineComputedStyles(svgText: string): string {
  // NOTE: do NOT set `visibility: hidden` or `display: none` here — both are
  // inheriting CSS properties, and getComputedStyle() would then return those
  // values on every descendant. We'd then copy them back into the SVG, making
  // the whole drawing invisible to Inkscape (and any viewer). Off-screen
  // positioning is sufficient; the BrowserWindow itself is already hidden.
  const scratch = document.createElement('div');
  scratch.style.position = 'absolute';
  scratch.style.left = '-99999px';
  scratch.style.top = '-99999px';
  scratch.style.width = '0';
  scratch.style.height = '0';
  scratch.style.overflow = 'hidden';
  scratch.style.pointerEvents = 'none';
  scratch.innerHTML = svgText;
  document.body.appendChild(scratch);

  try {
    const svgRoot = scratch.querySelector('svg') as SVGSVGElement | null;
    if (!svgRoot) return svgText;

    void svgRoot.getBoundingClientRect();

    const walker = document.createTreeWalker(svgRoot, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = svgRoot;
    let count = 0;
    while (node) {
      if (node instanceof Element && node.namespaceURI === 'http://www.w3.org/2000/svg') {
        const cs = window.getComputedStyle(node);
        const declarations: string[] = [];
        for (const prop of INLINE_PROPS) {
          const val = cs.getPropertyValue(prop);
          if (!val) continue;

          const skipValues = SKIP_IF_VALUE[prop];
          if (skipValues && skipValues.includes(val)) continue;

          // Skip obvious default fill only on unclassed wrappers — keep it on
          // anything with a class because mermaid's CSS may have explicitly set
          // it to black and we don't want to lose that.
          if (
            prop === 'fill' &&
            (val === 'rgb(0, 0, 0)' || val === 'rgba(0, 0, 0, 0)' || val === 'none') &&
            !node.getAttribute('class')
          ) {
            continue;
          }

          declarations.push(`${prop}: ${val}`);
          if (ATTR_MIRROR.has(prop)) {
            let attrVal = val;
            if (attrVal === 'currentcolor' || attrVal === 'currentColor') {
              attrVal = cs.getPropertyValue('color') || '#000';
            }
            node.setAttribute(prop, attrVal);
          }
        }
        if (declarations.length) {
          const existing = node.getAttribute('style');
          const merged = existing ? `${existing}; ${declarations.join('; ')}` : declarations.join('; ');
          node.setAttribute('style', merged);
        }
        count++;
      }
      node = walker.nextNode() as Element | null;
    }

    svgRoot.querySelectorAll('style').forEach((s) => s.remove());

    console.info(`[renderer] inlined styles on ${count} SVG elements`);
    return new XMLSerializer().serializeToString(svgRoot);
  } finally {
    scratch.remove();
  }
}

/**
 * Tags we hoist into a single flat top-level <g> with their own baked-in
 * transform. Anything else stays inside its existing parent (defs, markers,
 * etc. — those get filtered out separately below).
 */
const FLATTEN_LEAF_TAGS = new Set([
  'text', 'rect', 'path', 'circle', 'ellipse', 'line', 'polygon', 'polyline',
]);

interface Point2D { x: number; y: number; }

/**
 * Flattens an SVG so it imports cleanly into Visio. See the plan doc for the
 * full diagnosis; in short:
 *
 *   - Visio applies ancestor <g transform> to geometry nodes but NOT to the
 *     separate text-layout pipe, so <text> children end up mis-positioned.
 *     Fix: bake each leaf's cumulative CTM into its own transform attribute.
 *   - Visio can't resolve em-relative `dy` plus `dominant-baseline="central"`,
 *     so nested <tspan>s degenerate into page-flow "text blocks" dumped below
 *     the drawing. Fix: collapse nested <tspan>s to a single <text> carrying
 *     absolute x/y (measured via getBBox on the live DOM).
 *   - Visio drops marker-end arrowheads on ungroup. Fix: pre-compute each
 *     arrow tip + angle and emit an explicit <polygon>, then delete <marker>s.
 *
 * Runs inside the renderer so we have a live SVG DOM (getCTM, getBBox,
 * getPointAtLength). The SVG must already have inlined styles by this point
 * because we're about to destroy the ancestry those styles originally
 * cascaded through.
 */
function flattenForVisio(svgText: string): string {
  const scratch = document.createElement('div');
  scratch.style.position = 'absolute';
  scratch.style.left = '-99999px';
  scratch.style.top = '-99999px';
  scratch.style.width = '0';
  scratch.style.height = '0';
  scratch.style.overflow = 'hidden';
  scratch.style.pointerEvents = 'none';
  scratch.innerHTML = svgText;
  document.body.appendChild(scratch);

  try {
    const svgRoot = scratch.querySelector('svg') as SVGSVGElement | null;
    if (!svgRoot) return svgText;

    // Force layout so getCTM/getBBox/getPointAtLength have valid data.
    void svgRoot.getBoundingClientRect();

    // 1) Inline markers: replace marker-end refs on paths with explicit
    //    <polygon>s. Done BEFORE stroke-to-fill so we still have the
    //    original mermaid edge geometry to sample the tip from.
    inlineArrowMarkers(svgRoot);

    // 2) Convert pure-stroke edge paths (fill=none, stroke=something) into
    //    closed filled polygons. Visio's SVG importer silently drops shapes
    //    where `fill="none"` is the only visual, so edge shafts disappear on
    //    paste and you end up with just the arrowheads floating. A filled
    //    polygon of the same shape imports cleanly every time.
    strokeEdgesToFilledPolygons(svgRoot);

    // 3) Flatten <text>: collapse nested <tspan>s into a single text block
    //    with absolute x/y and no em-relative/baseline math. Done BEFORE the
    //    transform step because we want the bbox of the CURRENT DOM layout.
    collapseTextElements(svgRoot);

    // 4) Bake transforms: for every leaf, compute its CTM relative to the
    //    root <svg>, write that as matrix(...) on the element, hoist it into
    //    a single top-level <g>, and then delete the now-empty ancestor <g>s.
    bakeLeafTransforms(svgRoot);

    return new XMLSerializer().serializeToString(svgRoot);
  } finally {
    scratch.remove();
  }
}

/**
 * For each <path marker-end="url(#id)">: look up the <marker>, use the path's
 * end point + tangent to position an explicit arrowhead polygon, append it as
 * a sibling of the path, strip marker-end from the path. After all paths are
 * processed, delete every <marker> under <defs> (they're no longer referenced
 * and Visio would otherwise import them as stray shapes).
 */
function inlineArrowMarkers(svg: SVGSVGElement): void {
  const markers = new Map<string, SVGMarkerElement>();
  svg.querySelectorAll('marker').forEach((m) => {
    if (m.id) markers.set(m.id, m as SVGMarkerElement);
  });
  if (markers.size === 0) return;

  let replaced = 0;
  svg.querySelectorAll<SVGPathElement>('path[marker-end]').forEach((p) => {
    const ref = p.getAttribute('marker-end') || '';
    const id = /url\(#([^)]+)\)/.exec(ref)?.[1];
    if (!id) return;
    const marker = markers.get(id);
    if (!marker) return;

    let total = 0;
    try {
      total = p.getTotalLength();
    } catch {
      return;
    }
    if (!(total > 0)) return;

    let tip: Point2D;
    let prev: Point2D;
    try {
      tip = p.getPointAtLength(total);
      prev = p.getPointAtLength(Math.max(0, total - 1));
    } catch {
      return;
    }

    const angleRad = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    const polygon = buildArrowPolygon(marker, tip, angleRad, p);
    if (!polygon) return;

    p.removeAttribute('marker-end');
    p.parentNode?.insertBefore(polygon, p.nextSibling);
    replaced++;
  });

  // Markers are referenced only by marker-end/marker-start/marker-mid; after
  // stripping marker-end above there may still be unreferenced markers — but
  // we can just drop all of them because mermaid only uses them for arrow
  // tips, which we've already materialised.
  svg.querySelectorAll('marker').forEach((m) => m.remove());

  if (replaced > 0) {
    console.info(`[renderer] flattenForVisio: inlined ${replaced} marker-end arrowheads`);
  }
}

/**
 * Build a <polygon> that looks like `marker`'s visible children (mermaid's
 * arrowheads are a single <path> with a polygon-ish d="M0,0 L10,5 L0,10 z"
 * shape inside a marker with markerWidth/Height and refX/refY). We extract
 * the four corners from the first shape-ish child, remap them to sit with
 * their refX/refY at the tip, rotate by `angleRad`, and stroke/fill using
 * the source path's stroke colour so the arrowhead matches the edge.
 */
function buildArrowPolygon(
  marker: SVGMarkerElement,
  tip: Point2D,
  angleRad: number,
  sourcePath: SVGPathElement
): SVGPolygonElement | null {
  // Sample shape corners from the first <path>/<polygon> inside the marker.
  const shape = marker.querySelector<SVGGeometryElement>('path, polygon, polyline');
  if (!shape) return null;

  const markerW = parseFloat(marker.getAttribute('markerWidth') || '10') || 10;
  const markerH = parseFloat(marker.getAttribute('markerHeight') || '10') || 10;
  const refX = parseFloat(marker.getAttribute('refX') || '0') || 0;
  const refY = parseFloat(marker.getAttribute('refY') || `${markerH / 2}`) || markerH / 2;
  const vb = (marker.getAttribute('viewBox') || `0 0 ${markerW} ${markerH}`)
    .split(/[\s,]+/).map(parseFloat);
  const [vbX, vbY, vbW, vbH] = vb.length === 4 && vb.every(Number.isFinite)
    ? vb : [0, 0, markerW, markerH];

  // mermaid's standard arrowhead is "M0,0 L10,5 L0,10 z" in a 10x10 viewBox.
  // We sample three corner points from the shape to get a generic triangle,
  // which covers both <path> and <polygon> cases without full path parsing.
  let localPts: Point2D[];
  if (shape.tagName.toLowerCase() === 'polygon' || shape.tagName.toLowerCase() === 'polyline') {
    const raw = (shape.getAttribute('points') || '').trim();
    localPts = raw.split(/[\s,]+/).reduce<Point2D[]>((acc, v, i, arr) => {
      if (i % 2 === 0 && i + 1 < arr.length) {
        acc.push({ x: parseFloat(v), y: parseFloat(arr[i + 1]) });
      }
      return acc;
    }, []);
  } else {
    // Sample the path at 0, 1/3, 2/3 to approximate the silhouette as a
    // triangle — good enough for mermaid's simple arrowheads.
    try {
      const sp = shape as SVGPathElement;
      const len = sp.getTotalLength();
      localPts = [
        sp.getPointAtLength(0),
        sp.getPointAtLength(len / 3),
        sp.getPointAtLength((2 * len) / 3),
      ];
    } catch {
      return null;
    }
  }
  if (localPts.length < 3) return null;

  const stroke = sourcePath.getAttribute('stroke')
    || sourcePath.style.stroke
    || 'currentColor';

  // Scale factor from marker viewBox units to user units.
  const sx = markerW / (vbW || markerW);
  const sy = markerH / (vbH || markerH);

  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  // Each local point: translate so refX/refY sits at origin, scale to user
  // units, rotate by the path's tangent, translate to the tip.
  const transformed = localPts.map((p) => {
    const lx = (p.x - vbX - refX) * sx;
    const ly = (p.y - vbY - refY) * sy;
    const rx = lx * cosA - ly * sinA;
    const ry = lx * sinA + ly * cosA;
    return { x: tip.x + rx, y: tip.y + ry };
  });

  const polygon = document.createElementNS(SVG_NS, 'polygon');
  polygon.setAttribute(
    'points',
    transformed.map((p) => `${round(p.x)},${round(p.y)}`).join(' ')
  );
  polygon.setAttribute('fill', stroke);
  polygon.setAttribute('stroke', 'none');
  return polygon;
}

/**
 * Convert every pure-stroke edge path (fill=none + stroke) into a closed
 * filled polygon that traces the stroke's outline. Visio drops shapes whose
 * only visual is `stroke` on `fill="none"`, so mermaid edges come through as
 * just the arrowheads unless we rewrite them this way.
 *
 * Algorithm: sample the centerline with getPointAtLength(step), take a finite
 * difference to estimate the unit tangent at each sample, rotate 90° to get
 * the perpendicular, and offset by ±(strokeWidth/2) to get two parallel
 * rails. The left rail plus the reversed right rail form a closed polygon.
 */
function strokeEdgesToFilledPolygons(svg: SVGSVGElement): void {
  const paths = Array.from(svg.querySelectorAll<SVGPathElement>('path'));
  let converted = 0;
  for (const p of paths) {
    // Only touch pure-stroke edges. Leave filled shapes alone (node rounded
    // rects drawn as <path>, cluster backgrounds, etc.)
    const fill = (p.getAttribute('fill') || p.style.fill || '').trim();
    if (fill && fill !== 'none') continue;

    const strokeW = parseStrokeWidth(p);
    if (!(strokeW > 0)) continue;

    const stroke = (p.getAttribute('stroke') || p.style.stroke || '').trim();
    if (!stroke || stroke === 'none') continue;

    let total = 0;
    try {
      total = p.getTotalLength();
    } catch {
      continue;
    }
    if (!(total > 0.5)) continue;

    // Sample step: small enough for smooth Béziers, large enough to keep the
    // polygon reasonable. One sample per ~1px of arclength (clamped) works.
    const step = Math.max(0.5, Math.min(strokeW, 2));
    const samples: Point2D[] = [];
    for (let s = 0; s <= total; s += step) {
      try {
        samples.push(p.getPointAtLength(s));
      } catch {
        /* skip */
      }
    }
    // Ensure the true endpoint is included (loops on `s += step` may skip it).
    try {
      const last = samples[samples.length - 1];
      const endP = p.getPointAtLength(total);
      if (!last || Math.hypot(endP.x - last.x, endP.y - last.y) > 0.001) {
        samples.push(endP);
      }
    } catch {
      /* skip */
    }
    if (samples.length < 2) continue;

    const half = strokeW / 2;
    const left: Point2D[] = [];
    const right: Point2D[] = [];
    for (let i = 0; i < samples.length; i++) {
      // Tangent: central difference, falling back to forward/back at ends.
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(samples.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const mag = Math.hypot(tx, ty);
      if (mag < 1e-6) {
        // Degenerate (coincident samples); skip offset this iteration.
        continue;
      }
      tx /= mag;
      ty /= mag;
      // Perpendicular is (-ty, tx). Left = +perp*half, Right = -perp*half.
      const px = -ty;
      const py = tx;
      const c = samples[i];
      left.push({ x: c.x + px * half, y: c.y + py * half });
      right.push({ x: c.x - px * half, y: c.y - py * half });
    }
    if (left.length < 2) continue;

    const ringPoints = left.concat(right.reverse());
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute(
      'points',
      ringPoints.map((pt) => `${round(pt.x, 2)},${round(pt.y, 2)}`).join(' ')
    );
    polygon.setAttribute('fill', stroke);
    polygon.setAttribute('stroke', 'none');
    // Preserve the path's id so any external references survive (we don't
    // expect any for edges, but it also helps debugging in the saved file).
    const id = p.getAttribute('id');
    if (id) polygon.setAttribute('id', id);

    p.parentNode?.replaceChild(polygon, p);
    converted++;
  }
  if (converted > 0) {
    console.info(
      `[renderer] flattenForVisio: converted ${converted} stroked edges to filled polygons`
    );
  }
}

function parseStrokeWidth(el: Element): number {
  const raw =
    el.getAttribute('stroke-width')
    || (el as HTMLElement).style?.strokeWidth
    || '';
  if (!raw) return 1; // SVG default
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Collapse nested <tspan>s inside each <text> to a single <text> carrying the
 * string content as a direct child, plus absolute `x`/`y` taken from the
 * element's current layout bounding box. Strips `dy`, em-relative offsets,
 * `alignment-baseline`, and `dominant-baseline` — the exact attributes that
 * Visio's text-layout pipe mishandles.
 *
 * Multi-line labels (mermaid emits each line as its own outer <tspan>) keep
 * their line structure via sibling <tspan>s with absolute `x` and pixel-valued
 * `dy`.
 */
function collapseTextElements(svg: SVGSVGElement): void {
  const texts = Array.from(svg.querySelectorAll('text'));
  let collapsed = 0;
  for (const text of texts) {
    const t = text as SVGTextElement;

    // Collect each "line" — mermaid wraps each visual row in an outer
    // text-outer-tspan. A plain <text>Hello</text> with no tspans counts as
    // one line too.
    const outerTspans = Array.from(t.children).filter(
      (c) => c.tagName.toLowerCase() === 'tspan'
    ) as SVGTSpanElement[];

    const lines: string[] = [];
    if (outerTspans.length === 0) {
      lines.push(t.textContent?.trim() ?? '');
    } else {
      for (const outer of outerTspans) {
        lines.push((outer.textContent ?? '').trim());
      }
    }
    if (lines.length === 0) continue;

    // Capture the layout-position of the first visible character BEFORE we
    // mutate the DOM. Fall back to the text element's own x/y attributes if
    // getBBox blows up (it can for zero-length text).
    let absX = 0;
    let absY = 0;
    try {
      const bbox = t.getBBox();
      // getBBox returns bounds in the text element's OWN coordinate space,
      // not screen space. We want the y baseline, not the top, so approximate
      // it as bbox.y + 80% of height (works for Latin glyphs).
      absX = bbox.x + bbox.width / 2;
      absY = bbox.y + bbox.height * 0.8;
    } catch {
      absX = parseFloat(t.getAttribute('x') || '0') || 0;
      absY = parseFloat(t.getAttribute('y') || '0') || 0;
    }

    const fontSize = parseFloat(
      t.getAttribute('font-size')
        || getComputedStyle(t).fontSize
        || '16'
    ) || 16;

    // Wipe the children, strip the mishandled attributes.
    while (t.firstChild) t.removeChild(t.firstChild);
    t.removeAttribute('dy');
    t.removeAttribute('dx');
    // Keep text-anchor; it maps cleanly onto Visio's horizontal alignment.
    t.setAttribute('x', String(round(absX)));
    t.setAttribute('y', String(round(absY)));
    // text-anchor "middle" makes our measured centre the right anchor.
    if (!t.getAttribute('text-anchor')) t.setAttribute('text-anchor', 'middle');

    if (lines.length === 1) {
      t.appendChild(document.createTextNode(lines[0]));
    } else {
      lines.forEach((line, i) => {
        const span = document.createElementNS(SVG_NS, 'tspan');
        span.setAttribute('x', String(round(absX)));
        if (i > 0) span.setAttribute('dy', String(round(fontSize * 1.2)));
        span.appendChild(document.createTextNode(line));
        t.appendChild(span);
      });
    }

    collapsed++;
  }
  if (collapsed > 0) {
    console.info(`[renderer] flattenForVisio: collapsed ${collapsed} <text>s to single-level`);
  }
}

/**
 * For every leaf drawable (text/rect/path/circle/…) compute its CTM relative
 * to the <svg> root, write it back as a single matrix(...) on the element
 * itself, and hoist the element to be a direct child of a fresh top-level
 * <g class="visio-root">. After all leaves are moved, remove every other
 * <g> so the resulting tree is flat:
 *
 *   <svg>
 *     <defs>...</defs>
 *     <g class="visio-root">
 *       <rect transform="matrix(...)" .../>
 *       <text transform="matrix(...)" x=".." y="..">…</text>
 *       ...
 *     </g>
 *   </svg>
 */
function bakeLeafTransforms(svg: SVGSVGElement): void {
  const leaves: SVGGraphicsElement[] = [];
  svg.querySelectorAll<SVGGraphicsElement>('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (!FLATTEN_LEAF_TAGS.has(tag)) return;
    // Skip anything that lives inside <defs> or <marker> (not rendered).
    if (el.closest('defs') || el.closest('marker')) return;
    // Skip non-graphics elements (just in case).
    if (typeof (el as SVGGraphicsElement).getCTM !== 'function') return;
    leaves.push(el);
  });

  const visioRoot = document.createElementNS(SVG_NS, 'g');
  visioRoot.setAttribute('class', 'visio-root');

  for (const leaf of leaves) {
    const ctm = leaf.getCTM();
    // getCTM is nullable (detached elements); fall back to own transform.
    let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
    if (ctm) {
      a = ctm.a; b = ctm.b; c = ctm.c; d = ctm.d; e = ctm.e; f = ctm.f;
    }
    const matrix = `matrix(${round(a, 6)} ${round(b, 6)} ${round(c, 6)} ${round(d, 6)} ${round(e, 3)} ${round(f, 3)})`;
    leaf.setAttribute('transform', matrix);
    visioRoot.appendChild(leaf);
  }

  // Drop every remaining <g> that's a child of <svg> (they're now empty).
  const toRemove: Element[] = [];
  svg.querySelectorAll('g').forEach((g) => {
    if (g === visioRoot) return;
    // Leave <g>s inside <defs>/<marker> alone.
    if (g.closest('defs') || g.closest('marker')) return;
    toRemove.push(g);
  });
  // Remove in reverse so we don't disturb iteration.
  for (let i = toRemove.length - 1; i >= 0; i--) {
    toRemove[i].remove();
  }

  svg.appendChild(visioRoot);
  console.info(`[renderer] flattenForVisio: baked ${leaves.length} leaves into flat <g>`);
}

function round(n: number, digits: number = 2): number {
  if (!Number.isFinite(n)) return 0;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function patchHtmlVoidTags(svg: string): string {
  const voidTags = [
    'br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base',
    'col', 'embed', 'source', 'track', 'wbr',
  ];
  let out = svg;
  for (const t of voidTags) {
    const re = new RegExp(`<${t}(\\s[^>]*)?(?<!/)>`, 'gi');
    out = out.replace(re, (_m, attrs) => `<${t}${attrs ?? ''}/>`);
  }
  return out;
}

/**
 * Inserts the mermaid SVG directly into the DOM at the caller's scaled pixel
 * dimensions. The main process then calls `webContents.capturePage` to get the
 * rasterization — this sidesteps the canvas-taint issue we hit when loading
 * the SVG via <img> (mermaid's @font-face URLs and foreignObject content make
 * Chromium flag the canvas cross-origin even for blob: URLs).
 */
async function renderOnce(input: RenderInput): Promise<RenderOk | RenderErr> {
  try {
    const htmlLabels = input.htmlLabels !== false;
    // Mermaid 11 moved htmlLabels to the ROOT of the config. The older
    // `flowchart.htmlLabels` is deprecated and ignored by the flowchart-v2
    // renderer, which keeps emitting <foreignObject> regardless. We set it at
    // both levels for belt-and-braces compatibility.
    mermaid.initialize({
      startOnLoad: false,
      theme: input.theme,
      securityLevel: 'strict',
      htmlLabels,
      flowchart: { htmlLabels, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    });

    const { svg: rawSvg } = await mermaid.render(
      'mmd-' + Date.now().toString(36),
      input.code
    );
    if (!rawSvg) return { error: 'mermaid produced no SVG' };
    console.info(`[renderer] mermaid rendered, svg length=${rawSvg.length}`);

    const { svg, width, height } = normalizeSvg(rawSvg);
    console.info(`[renderer] normalized dimensions ${width}x${height}, svg length=${svg.length}`);

    const scaledW = Math.min(MAX_DIMENSION, Math.round(width * input.scale));
    const scaledH = Math.min(MAX_DIMENSION, Math.round(height * input.scale));

    if (input.skipDomInject) {
      let outSvg = svg;
      if (input.inlineStyles !== false) {
        try {
          outSvg = inlineComputedStyles(svg);
          console.info(
            `[renderer] secondary pass: flattened styles ${svg.length} -> ${outSvg.length}`
          );
        } catch (e) {
          console.warn('[renderer] inlineComputedStyles failed, returning raw SVG', e);
        }
      } else {
        console.info('[renderer] secondary pass: skipping style inlining (by request)');
      }
      if (input.flattenForVisio) {
        try {
          const before = outSvg.length;
          outSvg = flattenForVisio(outSvg);
          console.info(
            `[renderer] Visio pass: flattened transforms/tspans/markers ${before} -> ${outSvg.length}`
          );
        } catch (e) {
          console.warn('[renderer] flattenForVisio failed, returning pre-flatten SVG', e);
        }
      }
      return { svg: outSvg, width: scaledW, height: scaledH };
    }

    const body = document.body;
    const html = document.documentElement;
    html.style.margin = '0';
    html.style.padding = '0';
    html.style.background = 'white';
    body.style.margin = '0';
    body.style.padding = '0';
    body.style.background = 'white';
    body.style.width = `${scaledW}px`;
    body.style.height = `${scaledH}px`;
    body.style.overflow = 'hidden';

    const stage = document.getElementById('stage');
    if (!stage) return { error: '#stage element missing from renderer page', svg };

    stage.style.position = 'static';
    stage.style.left = '';
    stage.style.top = '';
    stage.style.margin = '0';
    stage.style.padding = '0';
    stage.style.width = `${scaledW}px`;
    stage.style.height = `${scaledH}px`;
    stage.style.background = 'white';
    stage.innerHTML = svg;

    const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return { error: 'failed to insert <svg> into stage', svg };
    svgEl.setAttribute('width', String(scaledW));
    svgEl.setAttribute('height', String(scaledH));
    svgEl.style.width = `${scaledW}px`;
    svgEl.style.height = `${scaledH}px`;
    svgEl.style.display = 'block';

    // Wait one paint frame so layout has settled before capturePage runs.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    return { svg, width: scaledW, height: scaledH };
  } catch (e) {
    console.error('[renderer] unhandled error in renderOnce', e);
    return { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) };
  }
}

function clearStage(): void {
  const stage = document.getElementById('stage');
  if (stage) stage.innerHTML = '';
}

declare global {
  interface Window {
    renderMermaid: (input: RenderInput) => Promise<RenderOk | RenderErr>;
    clearStage: () => void;
  }
}

window.renderMermaid = renderOnce;
window.clearStage = clearStage;

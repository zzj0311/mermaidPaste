export type MermaidTheme = 'default' | 'dark' | 'neutral' | 'forest';

export interface AppConfig {
  enabled: boolean;
  hotkey: string;
  scale: 2 | 3 | 4;
  theme: MermaidTheme;
  emitEmf: boolean;
  autoPaste: boolean;
  textToPath: boolean;
  inkscapePath: string | null;
  autoFlipDirection: boolean;
  flipRatio: number;
  /**
   * When true, run a second mermaid render with `htmlLabels: false` and feed
   * that SVG to Inkscape. This produces an EMF with real, selectable text in
   * Word/PowerPoint, at the cost of ~one extra render pass per hotkey.
   *
   * Why: mermaid's default flowchart labels are `<foreignObject>` + HTML,
   * which Inkscape's EMF exporter silently drops (you get shapes but no
   * text). `htmlLabels: false` makes mermaid emit native SVG <text>
   * elements, which Inkscape converts cleanly.
   */
  emfUsePlainText: boolean;
  /**
   * When true, also generate a Visio-friendly SVG (transforms baked into
   * leaves, tspans collapsed, arrowheads inlined) and publish it on the
   * clipboard as a file drop (CF_HDROP) so Visio accepts it on paste.
   */
  emitVisioSvg: boolean;
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
}

export interface RenderError {
  error: string;
  svg?: string;
}

export type RenderResponse = RenderResult | RenderError;

/**
 * Helpers for rewriting mermaid source text.
 *
 * Currently just `flipDirection`, used by the "auto-flip when too wide" path:
 * if a first render of a flowchart/graph comes back much wider than tall,
 * we re-render with the orientation swapped so it fits into Word's column
 * without being scaled down to illegibility.
 */

/**
 * Swap the top-level direction of a mermaid flowchart/graph source:
 *
 *   flowchart LR  -> flowchart TB
 *   flowchart RL  -> flowchart BT
 *   graph LR      -> graph TB
 *   graph RL      -> graph BT
 *
 * Also rewrites any `direction LR|RL` lines inside subgraphs so the whole
 * diagram flips coherently.
 *
 * Returns the rewritten source, or null if the diagram doesn't have a
 * horizontal direction we can flip (e.g. already TB, or a non-flowchart
 * diagram like sequenceDiagram / classDiagram).
 */
export function flipDirection(code: string): string | null {
  const flip: Record<string, string> = { LR: 'TB', RL: 'BT' };

  // Match the first non-empty, non-comment line that declares the diagram
  // header. We only touch `flowchart` and `graph` diagrams with a horizontal
  // direction; everything else is left untouched.
  const headerRe = /^([ \t]*)(flowchart|graph)([ \t]+)(LR|RL)\b/m;
  const m = code.match(headerRe);
  if (!m) return null;

  const newDir = flip[m[4]];
  if (!newDir) return null;

  let out = code.replace(headerRe, `$1$2$3${newDir}`);

  // Also flip any `direction LR|RL` lines inside subgraphs. Keep this
  // best-effort — if the user has something unusual we just leave it.
  out = out.replace(/^([ \t]*)direction([ \t]+)(LR|RL)\b/gm, (_match, pre, mid, dir) => {
    const nd = flip[dir];
    return nd ? `${pre}direction${mid}${nd}` : _match;
  });

  return out;
}

/**
 * True if width > ratio * height. Used to decide whether a first render is
 * "too wide" and worth retrying with the direction flipped.
 */
export function isTooWide(width: number, height: number, ratio: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return false;
  return width / height > ratio;
}

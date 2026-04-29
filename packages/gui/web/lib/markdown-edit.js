// Pure-string helpers for the markdown toolbar. No DOM, no React — kept
// in their own file so they're easy to unit-test.

/**
 * Wrap the substring [start, end) with `before` and `after`. Returns the
 * new string and the selection range that should be re-applied so the
 * caller can keep the user's text highlighted around the inserted markup.
 *
 * If nothing is selected (start === end) we still insert the markers and
 * place the caret between them — handy for "click bold then type".
 */
export function wrapInValue(value, start, end, before, after) {
  const a = after === undefined ? before : after;
  const head = value.slice(0, start);
  const sel = value.slice(start, end);
  const tail = value.slice(end);
  const next = head + before + sel + a + tail;
  if (start === end) {
    const caret = start + before.length;
    return { value: next, selectionStart: caret, selectionEnd: caret };
  }
  return {
    value: next,
    selectionStart: start + before.length,
    selectionEnd: end + before.length
  };
}

/**
 * Apply a prefix (e.g. `## `, `> `, `- `) to every line touched by the
 * selection. If [start, end) lands in the middle of a line, the whole
 * line gets the prefix — same UX as common markdown editors.
 */
export function linePrefixInValue(value, start, end, prefix) {
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  // Extend `end` to the end of its line so a partial selection still
  // re-prefixes the whole line — but don't go past EOF.
  let lineEnd = value.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const transformed = lines.map((l) => prefix + l).join('\n');
  const next = value.slice(0, lineStart) + transformed + value.slice(lineEnd);
  return {
    value: next,
    selectionStart: lineStart + prefix.length,
    selectionEnd: lineEnd + prefix.length * lines.length
  };
}

/**
 * Insert text at `pos` and place the caret immediately after it.
 */
export function insertAt(value, pos, text) {
  const next = value.slice(0, pos) + text + value.slice(pos);
  const caret = pos + text.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

/**
 * Build a markdown image-or-link snippet for an uploaded asset.
 * `kind === 'image'` produces `![alt](url)`, otherwise a plain link.
 */
export function assetSnippet(kind, label, url) {
  const safeLabel = (label ?? '').replace(/[\[\]]/g, '');
  if (kind === 'image') return `![${safeLabel}](${url})`;
  return `[${safeLabel || url}](${url})`;
}

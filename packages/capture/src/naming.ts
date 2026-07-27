/**
 * Layer naming.
 *
 * Figma's layer list is the main way a designer navigates an imported page, and
 * a tree of two thousand layers all called "DIV" is unusable. The rules below
 * prefer whatever a human would recognise: an accessible name, then a
 * meaningful class, then the tag.
 */

const MAX_NAME_LENGTH = 40;

/** Utility-first class names carry no meaning worth putting in the layer list. */
const UTILITY_CLASS = /^(?:[a-z]{1,3}-)?(?:\d|\[|(?:p|m|w|h|t|b|l|r|z|gap|flex|grid|text|bg|border|rounded|shadow|space|items|justify|self|col|row)[-xytblr]?-)/;

export function nameFor(element: Element, textSample?: string): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return truncate(aria);

  if (element instanceof HTMLImageElement && element.alt) {
    return truncate(element.alt);
  }

  if (textSample) {
    const trimmed = textSample.trim().replace(/\s+/g, ' ');
    if (trimmed) return truncate(trimmed);
  }

  const tag = element.tagName.toLowerCase();

  const id = element.getAttribute('id');
  if (id && !isGenerated(id)) return truncate(`${tag}#${id}`);

  const semantic = semanticClass(element);
  if (semantic) return truncate(`${tag}.${semantic}`);

  const role = element.getAttribute('role');
  if (role) return truncate(`${tag}[${role}]`);

  return tag;
}

function semanticClass(element: Element): string | null {
  const className = element.getAttribute('class');
  if (!className) return null;

  for (const candidate of className.trim().split(/\s+/)) {
    if (candidate.length < 3 || candidate.length > 30) continue;
    if (isGenerated(candidate)) continue;
    if (UTILITY_CLASS.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Detect CSS-module and CSS-in-JS hashes (`Button_root__x7f2a`, `css-1q2w3e`,
 * `sc-bdVaJa`). They change on every build and mean nothing to a designer.
 */
function isGenerated(value: string): boolean {
  if (/__[a-z0-9]{5,}$/i.test(value)) return true;
  if (/^(?:css|sc|jsx)-[a-z0-9]{5,}$/i.test(value)) return true;
  if (/^[a-z]?[0-9a-f]{7,}$/i.test(value)) return true;
  // Mostly digits and letters with no word structure at all.
  if (value.length > 8 && !/[aeiou]/i.test(value)) return true;
  return false;
}

function truncate(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_NAME_LENGTH ? `${clean.slice(0, MAX_NAME_LENGTH - 1)}…` : clean;
}

/**
 * Minimal CSS value tokenizing helpers.
 *
 * Only what the gradient, shadow and background parsers need: splitting a value
 * list on separators that are not nested inside parentheses. Naive
 * `String.split(',')` corrupts every value that contains an `rgba(...)`, which
 * is most of them.
 */

/** Split on top-level occurrences of `sep`, ignoring anything inside `(...)`. */
export function splitTopLevel(value: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inString: string | null = null;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (inString) {
      if (ch === inString && value[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/** Split on top-level whitespace runs, ignoring anything inside `(...)`. */
export function splitWhitespace(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (depth === 0 && /\s/.test(ch)) {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

/** `foo(bar, baz)` → `{ name: 'foo', args: 'bar, baz' }`. */
export function parseFunction(value: string): { name: string; args: string } | null {
  const open = value.indexOf('(');
  if (open <= 0 || !value.endsWith(')')) return null;
  return {
    name: value.slice(0, open).trim().toLowerCase(),
    args: value.slice(open + 1, -1).trim(),
  };
}

/** Convert any CSS angle unit to degrees. */
export function toDegrees(token: string): number | null {
  const n = Number.parseFloat(token);
  if (!Number.isFinite(n)) return null;
  const unit = token.replace(/^[-+.\d eE]+/, '').toLowerCase();
  switch (unit) {
    case 'deg':
    case '':
      return n;
    case 'rad':
      return (n * 180) / Math.PI;
    case 'grad':
      return n * 0.9;
    case 'turn':
      return n * 360;
    default:
      return null;
  }
}

/**
 * Resolve a CSS length or percentage to pixels.
 *
 * `getComputedStyle` resolves most lengths to px already; percentages survive
 * inside gradient and background-position values, which is why `reference` is
 * required.
 */
export function toPixels(token: string, reference: number): number | null {
  const n = Number.parseFloat(token);
  if (!Number.isFinite(n)) return null;
  if (token.trim().endsWith('%')) return (n / 100) * reference;
  const unit = token.replace(/^[-+.\d eE]+/, '').toLowerCase();
  switch (unit) {
    case 'px':
    case '':
      return n;
    // Chromium computes these away, but a capture running against a
    // non-Chromium engine later should not silently produce zeros.
    case 'pt':
      return (n * 96) / 72;
    case 'pc':
      return (n * 96) / 6;
    case 'in':
      return n * 96;
    case 'cm':
      return (n * 96) / 2.54;
    case 'mm':
      return (n * 96) / 25.4;
    case 'q':
      return (n * 96) / 101.6;
    default:
      return null;
  }
}

export function isNumeric(token: string): boolean {
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?[a-z%]*$/i.test(token.trim());
}

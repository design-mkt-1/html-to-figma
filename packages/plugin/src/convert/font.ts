import type { FontUsage } from '@h2f/schema';

/**
 * Web fonts → Figma fonts.
 *
 * Figma addresses a font by family plus a *style name* ("SemiBold Italic"),
 * while CSS addresses it by a numeric weight and a style keyword. There is no
 * canonical mapping between the two, and foundries disagree on spelling
 * ("Semibold", "Semi Bold", "Demi Bold"), so this parses whatever style names
 * the running Figma instance reports and scores them.
 */

export interface ResolvedFont {
  fontName: FontName;
  /** True when the family itself had to be substituted. */
  substituted: boolean;
}

/** Style-name tokens and the CSS weight they correspond to. */
const WEIGHT_TOKENS: Array<[string, number]> = [
  ['hairline', 100],
  ['thin', 100],
  ['extralight', 200],
  ['ultralight', 200],
  ['light', 300],
  ['book', 400],
  ['regular', 400],
  ['normal', 400],
  ['roman', 400],
  ['medium', 500],
  ['demibold', 600],
  ['semibold', 600],
  ['extrabold', 800],
  ['ultrabold', 800],
  ['bold', 700],
  ['black', 900],
  ['heavy', 900],
  ['ultra', 900],
  ['fat', 900],
];

/** Families to fall back to, in order, when the page's font is unavailable. */
const FALLBACK_FAMILIES = ['Inter', 'Roboto', 'Helvetica', 'Arial'];

export class FontResolver {
  /** Lower-cased family name → the family name as Figma spells it. */
  private readonly families = new Map<string, string>();
  /** Figma family name → its available styles. */
  private readonly styles = new Map<string, string[]>();
  private readonly cache = new Map<string, ResolvedFont>();
  private readonly fallback: string;

  constructor(available: FontName[]) {
    for (const font of available) {
      const key = normalizeFamily(font.family);
      if (!this.families.has(key)) {
        this.families.set(key, font.family);
        this.styles.set(font.family, []);
      }
      this.styles.get(this.families.get(key)!)!.push(font.style);
    }

    this.fallback =
      FALLBACK_FAMILIES.map((f) => this.families.get(normalizeFamily(f))).find(Boolean) ??
      available[0]?.family ??
      'Inter';
  }

  resolve(usage: FontUsage): ResolvedFont {
    const key = `${usage.family}|${usage.weight}|${usage.italic}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const family = this.families.get(normalizeFamily(usage.family));
    const target = family ?? this.fallback;

    const style = this.pickStyle(target, usage.weight, usage.italic);
    const resolved: ResolvedFont = {
      fontName: { family: target, style },
      substituted: family === undefined,
    };

    this.cache.set(key, resolved);
    return resolved;
  }

  /** Every font this document will need, deduplicated, for preloading. */
  resolveAll(usages: FontUsage[]): { fonts: FontName[]; missing: string[] } {
    const fonts = new Map<string, FontName>();
    const missing = new Set<string>();

    for (const usage of usages) {
      const resolved = this.resolve(usage);
      if (resolved.substituted) missing.add(usage.family);
      fonts.set(`${resolved.fontName.family}|${resolved.fontName.style}`, resolved.fontName);
    }

    return { fonts: [...fonts.values()], missing: [...missing] };
  }

  private pickStyle(family: string, weight: number, italic: boolean): string {
    const candidates = this.styles.get(family) ?? [];
    if (candidates.length === 0) return italic ? 'Italic' : 'Regular';

    let best = candidates[0]!;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      const parsed = parseStyleName(candidate);
      // A wrong slant is far more visible than a slightly wrong weight, so it
      // is weighted to outrank any weight difference (max distance is 800).
      const score = Math.abs(parsed.weight - weight) + (parsed.italic === italic ? 0 : 1000);

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best;
  }
}

export function parseStyleName(style: string): { weight: number; italic: boolean } {
  const normalized = style.toLowerCase().replace(/[\s_-]/g, '');
  const italic = normalized.includes('italic') || normalized.includes('oblique');
  const withoutSlant = normalized.replace(/italic|oblique/g, '');

  if (withoutSlant === '') return { weight: 400, italic };

  // Longest token first so "semibold" is not matched as "bold".
  for (const [token, weight] of WEIGHT_TOKENS) {
    if (withoutSlant.includes(token)) return { weight, italic };
  }

  // Some families expose numeric styles directly ("300", "Weight 700").
  const numeric = /(\d{3})/.exec(withoutSlant);
  if (numeric) {
    const weight = Number.parseInt(numeric[1]!, 10);
    if (weight >= 100 && weight <= 900) return { weight, italic };
  }

  return { weight: 400, italic };
}

function normalizeFamily(family: string): string {
  return family.toLowerCase().replace(/\s+/g, ' ').trim();
}

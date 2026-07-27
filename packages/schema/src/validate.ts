import { SCHEMA_VERSION } from './types.js';
import type { Capture, RootNode, SceneNode } from './types.js';

/** Roots are structurally elements, so the walk handles both. */
type AnyNode = SceneNode | RootNode;

/**
 * Structural validation of a capture document.
 *
 * Hand-rolled rather than schema-library based on purpose: this module is
 * bundled into the Figma plugin, where every kilobyte is shipped to the user,
 * and the plugin needs a trustworthy answer before it starts mutating a
 * document. It checks shape and invariants the builder relies on, not every
 * field.
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateCapture(input: unknown): ValidationResult {
  const errors: string[] = [];
  const doc = input as Partial<Capture> | null;

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['capture is not an object'] };
  }

  if (doc.version !== SCHEMA_VERSION) {
    errors.push(
      `unsupported schema version ${String(doc.version)}; this plugin reads version ${SCHEMA_VERSION}`,
    );
    // Version mismatch makes every other check meaningless.
    return { ok: false, errors };
  }

  if (!doc.meta || typeof doc.meta.url !== 'string') {
    errors.push('meta.url is missing');
  }
  if (!Array.isArray(doc.roots) || doc.roots.length === 0) {
    errors.push('roots must be a non-empty array');
  }
  if (!doc.assets || typeof doc.assets !== 'object') {
    errors.push('assets must be an object');
  }
  if (!Array.isArray(doc.fonts)) {
    errors.push('fonts must be an array');
  }

  if (errors.length > 0) return { ok: false, errors };

  const assets = doc.assets as Capture['assets'];
  const seenIds = new Set<string>();

  for (const root of doc.roots as Capture['roots']) {
    walk(root, '', errors, assets, seenIds);
  }

  return { ok: errors.length === 0, errors };
}

function walk(
  node: AnyNode,
  path: string,
  errors: string[],
  assets: Capture['assets'],
  seenIds: Set<string>,
): void {
  // Cap the error list; a malformed document would otherwise produce thousands
  // of lines and drown the one that matters.
  if (errors.length > 50) return;

  const here = path ? `${path} > ${node.name ?? '?'}` : (node.name ?? 'root');

  if (typeof node.id !== 'string' || node.id === '') {
    errors.push(`${here}: missing id`);
  } else if (seenIds.has(node.id)) {
    errors.push(`${here}: duplicate node id "${node.id}"`);
  } else {
    seenIds.add(node.id);
  }

  const r = node.rect;
  if (!r || !isFinite(r.x) || !isFinite(r.y) || !isFinite(r.width) || !isFinite(r.height)) {
    errors.push(`${here}: rect has non-finite values`);
  } else if (r.width < 0 || r.height < 0) {
    errors.push(`${here}: rect has negative size`);
  }

  switch (node.kind) {
    case 'ROOT':
    case 'ELEMENT': {
      if (node.rasterize !== undefined) requireAsset(node.rasterize, here, errors, assets);
      for (const child of node.children ?? []) {
        walk(child, here, errors, assets, seenIds);
      }
      break;
    }
    case 'TEXT': {
      if (typeof node.characters !== 'string') {
        errors.push(`${here}: text node has no characters`);
      }
      if (!node.base || typeof node.base.family !== 'string') {
        errors.push(`${here}: text node has no base style`);
      }
      for (const seg of node.segments ?? []) {
        if (seg.start < 0 || seg.end > node.characters.length || seg.start >= seg.end) {
          errors.push(
            `${here}: segment [${seg.start}, ${seg.end}) is out of range for ${node.characters.length} characters`,
          );
        }
      }
      break;
    }
    case 'IMAGE':
    case 'SVG': {
      requireAsset(node.asset, here, errors, assets);
      break;
    }
    default: {
      errors.push(`${here}: unknown node kind "${(node as { kind: string }).kind}"`);
    }
  }
}

function requireAsset(
  ref: string,
  path: string,
  errors: string[],
  assets: Capture['assets'],
): void {
  if (!(ref in assets)) {
    errors.push(`${path}: references missing asset "${ref}"`);
  }
}

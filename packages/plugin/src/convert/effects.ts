import type { Effect as IrEffect } from '@h2f/schema';
import { toRgba } from './paint.js';

/** IR effects → Figma effects. Pure. */
export function toEffects(effects: IrEffect[]): Effect[] {
  const out: Effect[] = [];

  for (const effect of effects) {
    switch (effect.kind) {
      case 'DROP_SHADOW':
        out.push({
          type: 'DROP_SHADOW',
          color: toRgba(effect.color),
          offset: { x: effect.offset.x, y: effect.offset.y },
          radius: Math.max(0, effect.radius),
          spread: effect.spread,
          visible: true,
          blendMode: effect.blendMode ?? 'NORMAL',
          // CSS draws a box-shadow behind the element, and a translucent
          // element shows the shadow through itself. Figma's default hides it.
          showShadowBehindNode: true,
        });
        break;

      case 'INNER_SHADOW':
        out.push({
          type: 'INNER_SHADOW',
          color: toRgba(effect.color),
          offset: { x: effect.offset.x, y: effect.offset.y },
          radius: Math.max(0, effect.radius),
          spread: effect.spread,
          visible: true,
          blendMode: effect.blendMode ?? 'NORMAL',
        });
        break;

      // `blurType: 'NORMAL'` distinguishes these from progressive blurs, which
      // CSS has no equivalent for.
      case 'LAYER_BLUR':
        out.push({
          type: 'LAYER_BLUR',
          blurType: 'NORMAL',
          radius: Math.max(0, effect.radius),
          visible: true,
        });
        break;

      case 'BACKGROUND_BLUR':
        out.push({
          type: 'BACKGROUND_BLUR',
          blurType: 'NORMAL',
          radius: Math.max(0, effect.radius),
          visible: true,
        });
        break;
    }
  }

  return out;
}

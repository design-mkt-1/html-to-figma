/**
 * The entire platform surface this package depends on.
 *
 * `lib` is deliberately ES2020 with no `DOM` and no `node` types, so that using
 * `document`, `Buffer` or `fetch` in here is a compile error rather than a
 * runtime surprise in whichever host does not have it. `TextEncoder` and
 * `TextDecoder` are the two exceptions: both are globals in Node 20, in
 * browsers and in MV3 service workers, so they are declared by hand rather than
 * dragged in with a whole lib.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

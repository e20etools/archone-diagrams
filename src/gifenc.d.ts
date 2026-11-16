declare module "gifenc" {
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: { palette?: number[][]; delay?: number; transparent?: boolean; repeat?: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(): Encoder;
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number, options?: object): number[][];
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][], format?: string): Uint8Array;
}

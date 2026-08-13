import QRCode from 'qrcode';
import UPNG from 'upng-js';

export interface RenderedQr {
  /** Raster PNG data URL — this is what clients display and scanners read. */
  qrDataUrl: string;
  /** Module matrix side length, excluding the quiet zone. */
  size: number;
  /** Rendered pixel side length, including the quiet zone. */
  pixels: number;
}

/** Bank apps need ≥4 modules of white around the symbol (ISO/IEC 18004 §6.3). */
const QUIET_ZONE_MODULES = 4;

/** Whole pixels per module. Integer-only scaling is the whole point: a
 *  fractional module size is what makes a rendered QR unreadable. */
const MODULE_PIXELS = 8;

/**
 * Render a QR payload to a PNG data URL.
 *
 * Deliberately *not* SVG. An SVG QR is drawn as a scaled vector path, so every
 * module edge lands on a fractional coordinate and the renderer snaps each one
 * independently — modules come out one device pixel wider or narrower than
 * their neighbours, and bank-app scanners fail to lock onto the grid. A PNG
 * built at a whole number of pixels per module has no such ambiguity: every
 * module is exactly MODULE_PIXELS square, with a full quiet zone baked in.
 */
export async function renderQr(payload: string): Promise<RenderedQr> {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;

  const pixels = (size + 2 * QUIET_ZONE_MODULES) * MODULE_PIXELS;
  const rgba = new Uint8Array(pixels * pixels * 4).fill(0xff);

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!data[row * size + col]) continue;
      const x0 = (col + QUIET_ZONE_MODULES) * MODULE_PIXELS;
      const y0 = (row + QUIET_ZONE_MODULES) * MODULE_PIXELS;
      for (let y = y0; y < y0 + MODULE_PIXELS; y += 1) {
        let i = (y * pixels + x0) * 4;
        for (let x = 0; x < MODULE_PIXELS; x += 1) {
          rgba[i] = 0;
          rgba[i + 1] = 0;
          rgba[i + 2] = 0;
          i += 4;
        }
      }
    }
  }

  // cnum 0 = lossless; the image is 2-colour so the file stays a few KB.
  const png = UPNG.encode([rgba.buffer], pixels, pixels, 0);
  return { qrDataUrl: `data:image/png;base64,${toBase64(png)}`, size, pixels };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked so a large symbol can't blow the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

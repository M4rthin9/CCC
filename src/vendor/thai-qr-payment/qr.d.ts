/**
 * Types for the vendored `qr.js` bundle (self-contained QR encoder copied
 * verbatim from `thai-qr-payment/dist/qr.js` — the published sub-path entry's
 * own `.d.ts` re-exports monorepo-relative source files that are absent from
 * the npm tarball, so the bundle is vendored here instead).
 */
export interface QRMatrix {
  size: number;
  modules: boolean[][];
  version: number;
  errorCorrectionLevel: string;
  mask: number;
}

export type QRMatrixErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface EncodeQROptions {
  errorCorrectionLevel?: QRMatrixErrorCorrectionLevel;
  minVersion?: number;
  maxVersion?: number;
  forceMask?: number;
}

export declare function encodeQR(text: string, options?: EncodeQROptions): QRMatrix;
export declare function detectMode(text: string): 'numeric' | 'alphanumeric' | 'byte';

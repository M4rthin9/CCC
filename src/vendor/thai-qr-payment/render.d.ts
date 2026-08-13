/**
 * Types for the vendored `render.js` bundle (self-contained SVG renderer with
 * the Thai QR Payment / PromptPay brand assets inline, copied verbatim from
 * `thai-qr-payment/dist/render.js`).
 */
import type { QRMatrix } from './qr';

export interface RenderQROptions {
  size?: number;
  quietZone?: number;
  foreground?: string;
  background?: string;
  rootAttributes?: Record<string, string>;
}

export interface RenderCardOptions {
  theme?: 'color' | 'silhouette';
  background?: string;
  accent?: string;
  qrColor?: string;
  headerLogo?: string;
  promptpayLogo?: string;
  centerOverlay?: string;
  showCaption?: boolean;
  merchantName?: string;
  amountLabel?: string;
}

export declare function matrixToPath(matrix: QRMatrix): string;
export declare function renderQRSvg(matrix: QRMatrix, options?: RenderQROptions): string;
export declare function renderCard(matrix: QRMatrix, options?: RenderCardOptions): string;
export declare function renderThaiQRPayment(payload: string, options?: RenderCardOptions): string;
export declare function renderThaiQRPaymentMatrix(
  payload: string,
  options?: RenderCardOptions
): { matrix: QRMatrix; svg: string };

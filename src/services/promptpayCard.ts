import QRCode from 'qrcode';

/**
 * Branded PromptPay payment card, rendered as a self-contained SVG string.
 *
 * Replaces the vendored `thai-qr-payment` renderer: that bundle drew the QR
 * modules through a non-integer group scale and overlaid the Thai QR logo
 * watermark dead-center on the symbol, so real Thai bank apps refused to scan
 * it even though the payload was correct (lenient decoders like jsQR still
 * recovered the data). This card embeds the QR produced by the battle-tested
 * `qrcode` library — the exact same renderer the dashboard's plain QR uses and
 * that pays fine — with a clean quiet zone and no logo overlay.
 *
 * The brand artwork (Thai QR Payment header + PromptPay sub-mark) is inlined
 * as static SVG so no vendored JS bundle is required at runtime.
 */

export interface PromptPayCardOptions {
  merchantName?: string;
  amountLabel?: string;
  showCaption?: boolean;
  /** Kept for API compatibility; the card is always rendered in color. */
  theme?: 'color' | 'silhouette';
  background?: string;
  accent?: string;
}

/** Thai QR Payment logo artwork (paths, from the official brand assets). */
const THAI_QR_HEADER_ART =
  '<path fill="#00427A" d="M0 0h913v376H0Z"/><path fill="#fdfdfd" d="M127 75h126l16 6 10 6 7 6 9 13 4 10 2 7 1 109 69 69v1H126l-16-5-12-7-8-7-7-10-5-10-3-12V125l4-14 6-11 9-10 9-7 13-6Z"/><path fill="#fbfcfc" d="M715 101h20l9 4 8 6 7 11 3 12v14l-3 12-3 6 1 4 8 7-1 4-7 6-4-2-8-8-10 4h-20l-10-3-8-6-6-8-4-10-1-6v-17l4-12 6-8 7-6 8-3Z"/><path fill="#00427A" d="M201 100h46l12 4 10 9 5 8 2 5v50h-42l-1-25-4-6-5-2-23-1Z"/><path fill="#00427A" d="M128 100h47v42l-24 1-6 4-2 4-1 25h-42v-48l4-11 9-10 8-5Z"/><path fill="#00427A" d="M100 201h42l1 24 4 6 3 2 25 1v42h-49l-12-6-5-4-6-9-3-10Z"/><path fill="#00A796" d="m234 201 7 6 68 68v1H201v-42l26-1 5-5 1-3Z"/><path fill="#fcfdfd" d="M779 102h33l10 4 6 5 4 8v10l-4 9-7 6-4 1 14 23 7 11v2h-16l-15-26-4-7-10-1v33h-14Z"/><path fill="#f9fafb" d="M570 207h18l12 32 5 14 2-3 15-40 1-3h18v69h-12l-1-49-16 43h-13l-16-43-1 49h-12Z"/><path fill="#fcfcfc" d="M576 102h12l30 75v3h-15l-6-16h-30l-6 16h-15l1-6Z"/><path fill="#fafafb" d="M472 101h14v33h34v-32h14v78h-14v-32h-35v32h-13Z"/><path fill="#f9f9fa" d="M719 207h13l10 16 18 30 1-46h12v69h-13l-17-28-11-19-1 47h-12Z"/><path fill="#fafafb" d="M467 207h10l5 11 22 55v3h-13l-5-13v-2h-28l-2 9-2 6h-14l3-10 23-57Z"/><path fill="#fdfdfd" d="M397 207h29l9 4 5 5 3 6v9l-3 8-6 5-7 3h-18v29h-12Z"/><path fill="#fbfbfc" d="M658 207h46v11h-33v18h31v11h-31v17h33v12h-46Z"/><path fill="#00427A" d="M717 114h13l10 5 4 5 3 7 1 5v11l-3 9h-3l-8-7-4 2-4 4-1 3 4 2 5 6-3 2h-14l-8-4-6-7-3-8v-16l4-9 6-7Z"/><path fill="#f0f0f4" d="M396 101h64v14h-24v66h-15v-66h-25Z"/><path fill="#fcfcfd" d="M497 207h15l8 13 8 14v2h2l2-5 14-24h15l-2 5-17 28-5 8-1 28h-13l-1-27-12-20-13-21Z"/><path fill="#fbfbfc" d="M783 207h55v11h-21v58h-13v-58h-21Z"/><path fill="#eeeff2" d="M629 101h15v80h-15Z"/><path fill="#00427A" d="M793 114h15l6 3 4 5v6l-5 6-2 1h-18Z"/><path fill="#00427A" d="M409 218h13l6 3 2 2v8l-4 4-4 1h-13Z"/><path fill="#00427A" d="m582 123 2 3 8 22v3h-20l1-5 8-22Z"/><path fill="#00427A" d="m472 226 2 2 7 20v2h-18l7-20Z"/>';

/** PromptPay sub-mark artwork (raster, from the official brand assets). */
const PROMPTPAY_SUBMARK_ART =
  '<image href="data:image/png;base64,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" x="0" y="0" width="384" height="130"/>';

const CARD_W = 600;
const CARD_H = 830;
const QR_X = 60;
const QR_Y = 250;
const QR_SIZE = 480;
const HEADER_ART_X = 195;
const HEADER_ART_Y = 15;
const HEADER_ART_W = 210;
const HEADER_ART_H = 80;
const SUBMARK_X = 170;
const SUBMARK_Y = 140;
const SUBMARK_W = 260;
const SUBMARK_H = 88;

/**
 * Branded PromptPay payment card. Async because the QR is rendered by the
 * `qrcode` library (the same encoder behind the dashboard's plain QR, which
 * pays reliably). Returns a self-contained SVG string for `{@html }` display.
 */
export async function renderPromptPayCardSvg(
  payload: string,
  options?: PromptPayCardOptions
): Promise<string> {
  const qrSvg = await QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 4,
  });
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(qrSvg)?.[1] ?? '';
  const vb = /viewBox="0 0 (\d+) \d+"/.exec(qrSvg)?.[1];
  const n = vb ? Number(vb) : 0;
  const scale = n > 0 ? QR_SIZE / n : QR_SIZE;

  const caption =
    options?.showCaption === false
      ? ''
      : `<text x="300" y="770" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="600" fill="#00427A">${xmlEscape(options?.merchantName ?? '')}</text>` +
        `<text x="300" y="804" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="30" font-weight="700" fill="#00427A">${xmlEscape(options?.amountLabel ?? '')}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" shape-rendering="crispEdges">` +
    `<defs>` +
    `<symbol id="tqp-header" viewBox="88 75 750 210">${THAI_QR_HEADER_ART}</symbol>` +
    `<symbol id="tqp-promptpay" viewBox="0 0 384 130">${PROMPTPAY_SUBMARK_ART}</symbol>` +
    `</defs>` +
    `<rect width="${CARD_W}" height="${CARD_H}" fill="#ffffff" rx="20"/>` +
    `<path d="M0 140 V20 a20 20 0 0 1 20 -20 H580 a20 20 0 0 1 20 20 V140 Z" fill="#00427A"/>` +
    `<use href="#tqp-header" x="${HEADER_ART_X}" y="${HEADER_ART_Y}" width="${HEADER_ART_W}" height="${HEADER_ART_H}" preserveAspectRatio="xMidYMid meet"/>` +
    `<use href="#tqp-promptpay" x="${SUBMARK_X}" y="${SUBMARK_Y}" width="${SUBMARK_W}" height="${SUBMARK_H}" preserveAspectRatio="xMidYMid meet"/>` +
    `<rect x="${QR_X}" y="${QR_Y}" width="${QR_SIZE}" height="${QR_SIZE}" fill="#ffffff" rx="6"/>` +
    `<g transform="translate(${QR_X} ${QR_Y}) scale(${scale})">${inner}</g>` +
    caption +
    `</svg>`
  );
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

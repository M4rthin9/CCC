import QRCode from 'qrcode';

export interface RenderedQr {
  svg: string;
  qrDataUrl: string;
}

/** Render a QR payload to SVG. Returns the SVG string (for tests) and a
 *  base64 data URL of the SVG (for <img src> on the clients). */
export async function renderQr(payload: string): Promise<RenderedQr> {
  const svg = await QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 300,
  });
  const b64 = btoa(svg);
  return { svg, qrDataUrl: `data:image/svg+xml;base64,${b64}` };
}

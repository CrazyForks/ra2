import { toDataURL } from 'qrcode';

/**
 * Generate the WeChat group QR code locally from text instead of an external image.
 * To update the code, change the text below; the next build generates the new image automatically.
 */
export const WECHAT_GROUP_QR_TEXT =
  'https://weixin.qq.com/g/AQYAAAMtS83wONOk6OEVm7BUg4pq2KpDdmSStHRPhwg-_M-913F_fxSfr5x_amFB';

/** Generate the WeChat group QR code as a PNG data URL; null for empty text. */
export function renderGroupQrDataUrl(text: string): Promise<string | null> {
  if (!text.trim()) return Promise.resolve(null);
  // High error correction plus a quiet zone keeps the code readable when reduced inside WeChat.
  return toDataURL(text, { width: 256, margin: 2, errorCorrectionLevel: 'H' });
}

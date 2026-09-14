import { toDataURL } from 'qrcode';

/**
 * 微信交流群二维码由文本在本地生成，不再引用外部图片。
 * 更新二维码时只需修改下面这一行文本，构建后自动生成新码。
 */
export const WECHAT_GROUP_QR_TEXT =
  'https://weixin.qq.com/g/AQYAAAMtS83wONOk6OEVm7BUg4pq2KpDdmSStHRPhwg-_M-913F_fxSfr5x_amFB';

/** 生成微信群二维码 PNG data URL；文本为空返回 null。 */
export function renderGroupQrDataUrl(text: string): Promise<string | null> {
  if (!text.trim()) return Promise.resolve(null);
  // 高容错 + 预留静区：微信内缩小展示后仍可稳定识别。
  return toDataURL(text, { width: 256, margin: 2, errorCorrectionLevel: 'H' });
}

import { t } from '../../../shared/i18n/translate';
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { renderGroupQrDataUrl, WECHAT_GROUP_QR_TEXT } from '../groupQr';

export function GroupDialog({ close }: { close(): void }) {
  const [failed, setFailed] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  // Generate the QR code from groupQr.ts text at runtime; empty text means unconfigured.
  useEffect(() => {
    let active = true;
    renderGroupQrDataUrl(WECHAT_GROUP_QR_TEXT)
      .then((src) => {
        if (active) setQrSrc(src);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const ready = !failed && qrSrc !== null;
  return (
    <Modal open title={t('微信交流群')} className="join-group-dialog" onClose={close}>
      <header>
        <h2>{t('微信交流群')}</h2>
        <button className="toolbar-button" type="button" aria-label={t('关闭微信群二维码')} onClick={close}>
          {t('关闭')}{' '}
        </button>
      </header>
      {ready && <img className="join-group-qr" src={qrSrc} alt={t('微信群二维码')} />}
      <p className={`join-group-hint${ready ? '' : ' error'}`}>
        {failed
          ? t('二维码生成失败，请稍后重试或刷新页面。')
          : qrSrc === null
            ? t('二维码暂未配置。')
            : t('微信扫码加入交流群，分享游戏体验、反馈问题与建议。')}
      </p>
    </Modal>
  );
}

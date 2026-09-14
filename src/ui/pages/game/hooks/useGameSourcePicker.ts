import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { GameSource } from '../../../../games/source';
import { createGameSourcePicker } from '../gameSourcePicker';
import { useStore } from '../../../shared/state/useStore';

/** file input 必须在用户手势里 click；除此之外由 React 接管普通 UI 事件与显示。 */
export function useGameSourcePicker(onSelected: (source: GameSource) => void) {
  const [service] = useState(() => createGameSourcePicker(onSelected));
  const state = useStore(service);
  const archiveRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const cancelPick = () => {
    if (pending.current) {
      pending.current = false;
      service.cancelPick();
    }
  };
  useEffect(() => {
    let timer = 0;
    const focus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!archiveRef.current?.files?.length && !folderRef.current?.files?.length) cancelPick();
      }, 200);
    };
    window.addEventListener('focus', focus);
    // React 尚未为 file input 暴露 cancel；在 hook 内对这一个浏览器 API 补充监听。
    const inputs = [archiveRef.current, folderRef.current];
    for (const input of inputs) input?.addEventListener('cancel', cancelPick);
    return () => {
      for (const input of inputs) input?.removeEventListener('cancel', cancelPick);
      window.removeEventListener('focus', focus);
      window.clearTimeout(timer);
      service.dispose();
    };
  }, [service]);
  const pick = (kind: 'archive' | 'folder' | 'development') => {
    if (kind === 'development') {
      void service.development();
      return;
    }
    service.beginPick();
    pending.current = true;
    (kind === 'archive' ? archiveRef : folderRef).current?.click();
  };
  const change = (kind: 'archive' | 'folder', event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    pending.current = false;
    if (!files.length) {
      service.cancelPick();
      return;
    }
    // 焦点兜底可能先按取消结算；迟到的 change 仍必须走完整导入，不能丢掉用户选择。
    if (kind === 'archive') void service.importArchive(files[0]!);
    else void service.importFolder(files);
  };
  return {
    ...state,
    archiveRef,
    folderRef,
    pick,
    cancelPick,
    chooseGame: service.chooseGame,
    archiveChanged: (event: ChangeEvent<HTMLInputElement>) => change('archive', event),
    folderChanged: (event: ChangeEvent<HTMLInputElement>) => change('folder', event),
  };
}

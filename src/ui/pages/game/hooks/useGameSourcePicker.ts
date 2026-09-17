import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { GameSource } from '../../../../games/source';
import { createGameSourcePicker } from '../gameSourcePicker';
import { useStore } from '../../../shared/state/useStore';

/** Click the file input within a user gesture; React handles all other ordinary UI events and display. */
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
    // React does not expose file-input cancel yet; supplement this one browser API with a listener inside the hook.
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
    // The focus fallback may settle as canceled first; a late change must still perform the full import and preserve the user's selection.
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

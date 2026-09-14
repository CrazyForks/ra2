import { createPortal } from 'react-dom';
import { lazy, Suspense } from 'react';
import { useStore } from '../../../shared/state/useStore';
import * as state from '../state/uiState';
import { RuntimeToolbarView } from './RuntimeToolbarView';
import { DebugPanel } from './DebugPanel';
import { GroupDialog } from './GroupDialog';
import { BootView, ExitPanel, ProblemPanel, ShortcutHelp, StatusView } from './RuntimePanels';

const GameSourcePickerView = lazy(() =>
  import('./GameSourcePickerView').then((module) => ({ default: module.GameSourcePickerView })),
);
const CustomMapDialog = lazy(() => import('./CustomMapDialog').then((module) => ({ default: module.CustomMapDialog })));

// 每个区域只订阅自己的低频快照，工具栏计数变化不会重新渲染画布或资源选择器。
export function Toolbar() {
  const props = useStore(state.toolbarState);
  const collapsed = useStore(state.controlsCollapsed);
  return (
    <nav id="vm-controls" aria-label="运行状态与控制" className={collapsed ? 'collapsed' : undefined}>
      {props && <RuntimeToolbarView {...props} />}
    </nav>
  );
}
export function DebugRegion() {
  const visible = useStore(state.debugVisible),
    props = useStore(state.debugState);
  return (
    <aside id="vm-debug" hidden={!visible} aria-label="调试信息">
      {props && <DebugPanel {...props} />}
    </aside>
  );
}
export function MainRegion() {
  const request = useStore(state.sourceRequest),
    panel = useStore(state.mainPanel);
  const help = useStore(state.helpVisible);
  return (
    <div id="ui">
      {request && (
        <Suspense fallback={<p role="status">正在加载资源选择器…</p>}>
          <GameSourcePickerView key={request.id} onSelected={request.finish} />
        </Suspense>
      )}
      {panel &&
        (panel.phase === 'exited' ? (
          <ExitPanel detail={panel.detail} />
        ) : (
          <ProblemPanel phase={panel.phase} detail={panel.detail} />
        ))}
      {help && <ShortcutHelp close={() => state.helpVisible.set(false)} />}
    </div>
  );
}
export function BootRegion() {
  const boot = useStore(state.bootState);
  return boot && <BootView {...boot} />;
}
export function ScreenStatus() {
  const network = useStore(state.networkStatus),
    resource = useStore(state.resourceStatus);
  const upscale = useStore(state.upscaleStatus);
  return (
    <>
      <output id="vm-upscale-status" role="status" aria-live="polite" hidden={upscale === null}>
        {upscale}
      </output>
      {network && <StatusView id="vm-network-status" bottom={38} value={network} />}
      {resource && <StatusView id="vm-resource-status" bottom={8} value={resource} />}
    </>
  );
}
export function Dialogs() {
  const group = useStore(state.groupVisible),
    maps = useStore(state.mapRequest);
  return createPortal(
    <>
      {group && <GroupDialog close={() => state.groupVisible.set(false)} />}
      {maps && (
        <Suspense fallback={<p role="status">正在加载地图管理…</p>}>
          <CustomMapDialog key={maps.id} gameId={maps.gameId} applyLive={maps.applyLive} finish={maps.finish} />
        </Suspense>
      )}
    </>,
    document.body,
  );
}

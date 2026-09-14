import type { RelaySocket } from 'relay-package/client';
import type { GuestMemory, VmNetworkStatus, Win32ShimOptions } from '../../vm86/win32';
import { Win32Shim } from '../win32Shim';
import { RA2_YR_RESOURCE_POLICY } from './resourcePolicy';
import { createRa2WebSocketTransport, type Ra2NetworkConfig } from '../ra2/networkTransport';

/** 两种宿主模式共用游戏配置，不反向导入 VM 驱动或 UI。
 * 配置函数在各自线程本地执行，不把工厂函数放进 Worker 消息协议。
 */
export function ra2YrVmConfiguration(
  onNetworkStatus?: (status: VmNetworkStatus) => void,
  network?: Ra2NetworkConfig,
  socketFactory?: (url: string) => RelaySocket,
) {
  return {
    resourcePolicy: RA2_YR_RESOURCE_POLICY,
    createShim: (memory: GuestMemory, options: Win32ShimOptions = {}) =>
      new Win32Shim(memory, {
        ...options,
        ra2NetworkEnabled: network !== undefined,
        ra2NetworkRoom: network?.room,
        ra2ExeHash: network?.exeHash,
        ...(network
          ? ({
              ra2NetworkTransportFactory: (handlers, join) =>
                createRa2WebSocketTransport(handlers, join, { url: network.relayUrl, socketFactory }),
            } satisfies Partial<ConstructorParameters<typeof Win32Shim>[1]>)
          : {}),
        onNetworkStatus: (status) => onNetworkStatus?.(status),
      }),
  };
}

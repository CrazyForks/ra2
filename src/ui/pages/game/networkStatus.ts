import type { VmNetworkStatus } from '../../../vm86/win32';
import { RA2NET_MAX_LAN_MEMBERS } from '../../../games/ra2/networkWire';

/** 状态文案不把中继 RTT 当成对手延迟，也不承诺原生对局自动恢复。 */
export function formatNetworkStatus(status: VmNetworkStatus): string {
  if (status.phase === 'connecting') return '联机：正在连接中继…';
  if (status.phase === 'disconnected' && status.detail === 'closed') return '联机：已关闭';
  if (status.phase === 'connected') {
    return (
      `联机：已连接 · 其他成员 ${status.peers}` +
      (status.relayRttMs === undefined ? '' : ` · 中继 RTT ${status.relayRttMs} ms`)
    );
  }
  const reasons: Record<string, string> = {
    'handshake timeout': '中继握手超时',
    'hello timeout': '中继握手超时',
    'version mismatch': '游戏版本不一致',
    'room full': `虚拟 LAN 已满（最多 ${RA2NET_MAX_LAN_MEMBERS} 人）`,
    'slow consumer': '发送积压超过上限',
    'relay closing': '中继正在关闭',
    'rate limit exceeded': '发送频率超过限制',
    'code=1006': '网络异常断开',
    closed: '连接已关闭',
    'relay draining': '中继维护中，暂不接纳新玩家',
    'relay busy': '中继连接数已达上限',
  };
  return `联机不可用：${reasons[status.detail] ?? status.detail}。当前不支持断线续局，请退出对局后重新启动游戏。`;
}

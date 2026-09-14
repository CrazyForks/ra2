import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { sha256 } from '../../../scripts/ci/gameResources';
import { GAME_MANIFESTS } from '../../../src/games/manifest';
import { describeShortGameContract } from '../../helpers/shortGameContract';

const path = resolve(process.env.RA2_THIRD_PARTY_CACHE_DIR || '.tmp-third-party', 'game.exe');
const available = existsSync(path);
if (!available && process.env.VM_REQUIRE_GAME_RESOURCES === '1') throw new Error('真实补丁验收缺少主程序 game.exe');
describe.skipIf(!available)('RA2 原始指令与快速游戏补丁', () => {
  if (!available) {
    it('需要本地主程序', () => {});
    return;
  }
  const executable = readFileSync(path);
  if (sha256(executable) !== GAME_MANIFESTS.ra2.thirdParty[0]!.sha256) throw new Error('真实补丁验收 EXE 哈希不匹配');
  describeShortGameContract((address, size) => executable.subarray(address - 0x400000, address - 0x400000 + size));
});

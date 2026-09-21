import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe } from 'vitest';
import { sha256 } from '../../../scripts/ci/gameResources';
import { GAME_MANIFESTS } from '../../../src/games/manifest';
import { describeShortGameContract } from '../../helpers/shortGameContract';

const path = resolve(process.env.RA2_THIRD_PARTY_CACHE_DIR || '.tmp-third-party', 'game.exe');
// Patch acceptance needs the fixed third-party executable; a missing file must fail instead of skipping the suite.
if (!existsSync(path)) throw new Error(`真实补丁验收缺少主程序 ${path}`);
const executable = readFileSync(path);
if (sha256(executable) !== GAME_MANIFESTS.ra2.thirdParty[0]!.sha256) throw new Error('真实补丁验收 EXE 哈希不匹配');
describe('RA2 原始指令与快速游戏补丁', () => {
  describeShortGameContract((address, size) => executable.subarray(address - 0x400000, address - 0x400000 + size));
});

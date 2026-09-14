import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { createArchiveExtractor, type ArchiveDirectoryRule } from '../../src/utils/archive/archiveExtractor';

it('通用提取器不内置游戏归位规则，按调用方规则选择目录', async () => {
  const bytes = zipSync({ 'install/tauam01.wav': strToU8('sound'), 'other.txt': strToU8('ignored') });
  async function extract(wanted: string[], directoryRules?: readonly ArchiveDirectoryRule[]) {
    const files = new Map<string, Uint8Array>();
    let done = false;
    const run = createArchiveExtractor({
      mountInput(seven) {
        seven.FS.writeFile('/work/archive.bin', bytes);
      },
      post(message) {
        if (message.type === 'error') throw Error(message.message);
        if (message.type === 'file') files.set(message.name, message.bytes);
        if (message.type === 'done') done = true;
      },
    });
    await run({ type: 'extract', wanted, directoryRules });
    expect(done).toBe(true);
    return [...files.keys()];
  }
  expect(await extract(['taunts/'])).toEqual([]);
  const rules = [{ directory: 'voices/', basenamePattern: '^tau.*\\.wav$' }];
  expect(await extract(['voices/'], rules)).toEqual(['voices/tauam01.wav']);
  expect(await extract(['taunts/'], rules)).toEqual([]);
});

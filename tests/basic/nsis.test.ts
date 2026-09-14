/**
 * NSIS 安装包解析单元测试：合成容器（真实格式布局 + LZMA 压缩，由 Python
 * lzma 生成一次后内嵌）覆盖签名定位、solid 流解码、指令流文件枚举。
 * 真实联机包（206MB）的端到端校验见 tests/real-game/smoke/ra2NsisSmoke.mts。
 */
import { describe, expect, it } from 'vitest';
import { decodeLzmaStream } from '../../src/utils/archive/lzmaDecode';
import {
  decodeAndParseNsis,
  decodeNsisSplitFiles,
  findNsisArchive,
  parseNsisFiles,
} from '../../src/utils/archive/nsis';

/**
 * 合成容器内容（真实 NSIS 布局）：[MZ stub][16B 签名][u32 头长][u32 归档长][LZMA 流]。
 * 解码输出 = [u32 头长][头块][每文件 u32 长度 + 数据]；指令流含两条
 * SetOutPath（rmcache → 空）与三条 ExtractFile，覆盖目录前缀切换与嵌套路径。
 */
const FIXTURE_BASE64 =
  'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADvvq3eTnVsbHNvZnRJbnN0/wAAAH8AAABdAAAABAB/gDAQD4WorOPiHWz0K92CiLCUH5X1CmM3pCWksvr2jnsQVFtyaglX6+g0w5uS5ElD7VdCVl9qFdIfA0xt6YAle8QiYgsj02jjJHioRVvfj/Xp7OQkICZa+K9ThOgYUE/ggzn4mkjr8g97CHuzfAMoAo+iaf/81OqA';
const FIXTURE = Uint8Array.from(atob(FIXTURE_BASE64), (char) => char.charCodeAt(0));
/** 合成解码输出的总长度（4 头长 + 头 + 数据）。 */
const DECODED_LENGTH = 298;

describe('NSIS 安装包解析', () => {
  it('定位签名并报告头长与流起点', () => {
    const info = findNsisArchive(FIXTURE);
    expect(info).not.toBeNull();
    expect(info!.headerSize).toBe(255);
    // stub 128 + 签名 16 + 头长 4 + 归档长 4
    expect(info!.streamStart).toBe(128 + 16 + 8);
  });

  it('非 NSIS 内容返回 null', () => {
    expect(findNsisArchive(new Uint8Array(512))).toBeNull();
    const mz = Uint8Array.from(atob('TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), (c) =>
      c.charCodeAt(0),
    );
    expect(findNsisArchive(mz)).toBeNull();
  });

  it('解码 solid 流并枚举文件（含 SetOutPath 前缀切换）', async () => {
    const info = findNsisArchive(FIXTURE)!;
    const decoded = await decodeLzmaStream({
      stream: FIXTURE.subarray(info.streamStart),
      outputSize: DECODED_LENGTH,
    });
    const files = parseNsisFiles(decoded);
    expect(files.map((file) => file.path).sort()).toEqual(['game.exe', 'rmcache/preview.mmp', 'sub/dir/file.bin']);
    const read = (path: string): Uint8Array => {
      const file = files.find((candidate) => candidate.path === path)!;
      return decoded.subarray(file.offset + 4, file.offset + 4 + file.size);
    };
    expect(new TextDecoder().decode(read('game.exe'))).toBe('MZfake-game');
    expect(new TextDecoder().decode(read('rmcache/preview.mmp'))).toBe('mmp-data');
    expect(new TextDecoder().decode(read('sub/dir/file.bin'))).toBe('bin-data');
  });

  it('声明的输出长度大于实际内容时报错', async () => {
    const info = findNsisArchive(FIXTURE)!;
    await expect(
      decodeLzmaStream({
        stream: FIXTURE.subarray(info.streamStart),
        outputSize: DECODED_LENGTH + 100,
      }),
    ).rejects.toThrow();
  });
});

describe('NSIS 两段流变体（重打包安装器）', () => {
  /**
   * 合成容器（与 YR jb51 安装器同构，Python lzma 生成一次后内嵌）：
   * [MZ stub][签名][u32 头长][4 字节 junk][头流 props 在 junk 后] + [00 80 分隔]
   * + 每文件独立 LZMA 流。头块 = flags-first（u32 标志 + 8 块头），
   * EW_EXTRACTFILE 的 params[2] = 各流相对首个数据流的偏移。
   */
  const SPLIT_BASE64 =
    'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADvvq3eTnVsbHNvZnRJbnN0kQAAAAECAwRdAACAAABAgC9uRIQwFz4PbvEA4FcKUtnWsSRLtLM+u+RZyeK0Ur2TwzsFM0i74dj/v//mBYAAAIBdAACAAAAmloktFqDa2/6nDTo2Ig43peOxOf6ZEf/HxIAAAIBdAACAAAAoEsktFqDa2/6nDTo2JVjHpeOxOf6ZEf/HxIAA';
  const SPLIT_FIXTURE = Uint8Array.from(atob(SPLIT_BASE64), (char) => char.charCodeAt(0));

  it('flags-first 头块 + 每文件独立流：定位载荷起点并逐流解码', async () => {
    const nsis = findNsisArchive(SPLIT_FIXTURE)!;
    expect(nsis.headerSize).toBe(145);
    const decoded = await decodeAndParseNsis(SPLIT_FIXTURE, nsis);
    expect(decoded.kind).toBe('split');
    if (decoded.kind !== 'split') return;
    expect(decoded.files.map((file) => file.path)).toEqual(['file1.bin', 'file2.bin']);
    expect(decoded.files.map((file) => file.streamOffset)).toEqual([0, 36]);
    const file1 = new TextEncoder().encode('MZfake-file-1-data');
    const file2 = new TextEncoder().encode('PKfake-file-2-data');
    expect(await decodeLzmaStream({ stream: SPLIT_FIXTURE.subarray(decoded.payloadStart + 0) })).toEqual(file1);
    expect(await decodeLzmaStream({ stream: SPLIT_FIXTURE.subarray(decoded.payloadStart + 36) })).toEqual(file2);
  });
});

describe('NSIS 两段流：单条损坏不中断后续文件', () => {
  /**
   * 合成容器（与上例同构、python lzma 生成一次后内嵌）：firstheader 带
   * flags/siginfo，三个 EW_EXTRACTFILE 指向三条独立流；file2 的流尾
   * （含 EOS 结尾）被截掉，解码必报 corrupted input。对应共享提取器的
   * 实际缺陷：YR jb51 安装器 movies01.mix 的桩流损坏，曾导致其后必需的
   * ra2md.mix 整体没解出。
   */
  const BROKEN_SPLIT_BASE64 =
    'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA776t3u++rd5OdWxsc29mdEluc3S3AAAAnQAAAF0AAIAAAABuAIx7HhLqHOJW+I3JgaBLjDwFh9Yg9Fe4MIJ8/aoYtAgL2FOVfOqkvy5CLmfZkCv//7OuAABdAACAAAAmloktFqDa2/6nDTo2Ig43peOxOf6ZEf/HxIAAXQAAgAAAKBLJLRag2tv+pw06NiVYx6XjsTn+mV0AAIAAACgSyS0WoNrb/qcNOjYoo1el47E5/pkR/8fEgAA=';

  it('损坏流只跳过该文件，前后文件仍解码收集', async () => {
    const fixture = Uint8Array.from(atob(BROKEN_SPLIT_BASE64), (char) => char.charCodeAt(0));
    const nsis = findNsisArchive(fixture)!;
    const decoded = await decodeAndParseNsis(fixture, nsis);
    expect(decoded.kind).toBe('split');
    if (decoded.kind !== 'split') return;
    expect(decoded.files.map((file) => file.path)).toEqual(['file1.bin', 'file2.bin', 'file3.bin']);

    const collected = new Map<string, string>();
    const statuses: string[] = [];
    const skipped = await decodeNsisSplitFiles({
      bytes: fixture,
      payloadStart: decoded.payloadStart,
      files: decoded.files,
      isTarget: (path) => path.endsWith('.bin'),
      decode: (stream) => decodeLzmaStream({ stream, transferInput: false }),
      collect: async (path, out) => {
        collected.set(path, new TextDecoder().decode(out));
      },
      onStatus: (message) => statuses.push(message),
    });
    expect(Object.fromEntries(collected)).toEqual({
      'file1.bin': 'MZfake-file-1-data',
      'file3.bin': 'PKfake-file-3-data',
    });
    expect(skipped).toEqual(['file2.bin（corrupted input）']);
    expect(statuses).toContain('NSIS 流损坏，跳过：file2.bin');
  });
});

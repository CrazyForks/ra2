/**
 * NSIS 安装包（solid LZMA）最小解析器。
 *
 * 参考 7-Zip 的 CPP/7zip/Archive/Nsis/{NsisIn.cpp,NsisDecode.cpp}（该实现会完整
 * 执行安装脚本 VM；本模块只走文件枚举所需的最小指令子集：EW_EXTRACTFILE /
 * EW_CREATEDIR(SetOutPath)）。格式要点（NSIS-2 实测 + 7-Zip 源码交叉验证）：
 *
 *   - 签名扫描：16 字节 {EF BE AD DE, "NullsoftInst"}，位于 firstheader 内。
 *   - firstheader 后紧跟一条 LZMA-Alone 流（props+dict 5 字节头，无长度字段）：
 *     解码输出 = [u32 头长][头块字节][每文件 u32 长度 + 文件数据]（solid 单流）。
 *   - 头块：跳过 4 字节引导 u32 后为 8 个 {offset:u32, num:u32}；块 2 = 指令流
 *     （每条 28 字节：which + 6×params），块 3/4 = 字符串表边界。
 *   - EW_EXTRACTFILE(20)：params[1]=名字符串偏移，params[2]=solid 数据偏移。
 *   - 字符串表首 u16==0 为 UTF-16LE，否则 ANSI（latin1）。
 */
import { normalizeWindowsPath } from '../windowsPath';
import { decodeLzmaStream, decodeLzmaStreamWithConsumed } from './lzmaDecode';

/** 16 字节 NSIS 签名：DE AD BE EF（小端）+ "NullsoftInst"。 */
const NSIS_SIGNATURE = new Uint8Array([
  0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74,
]);

/** NSIS 指令（28 字节 = which + 6×params）里 EW_* 的最小子集。 */
const EW_CREATEDIR = 11;
const EW_EXTRACTFILE = 20;

/** 指令流每条命令的字节长度。 */
const NSIS_COMMAND_BYTES = 4 + 6 * 4;

export interface NsisArchiveInfo {
  /** firstheader 里声明的头块字节数。 */
  headerSize: number;
  /** LZMA 流在容器内的起始偏移。 */
  streamStart: number;
}

export interface NsisFileEntry {
  /** 归一化后的客体内路径。 */
  path: string;
  /** solid 流中该文件 u32 长度前缀在解码输出内的偏移。 */
  offset: number;
  /** 文件内容字节数（u32 长度前缀记录的值）。 */
  size: number;
}

/** 在容器字节里定位 NSIS 签名；不是 NSIS 安装包时返回 null。 */
export function findNsisArchive(bytes: Uint8Array): NsisArchiveInfo | null {
  const magic = NSIS_SIGNATURE.subarray(4);
  let search = bytes.indexOf(magic[0]!);
  while (search >= 0) {
    // 签名 16 字节：EF BE AD DE + "NullsoftInst"（search 指向 "NullsoftInst" 的 N，
    // 即签名起点 +4）；其后紧跟 u32 头长（search+12）、u32 归档长（search+16）、
    // LZMA 流（search+20）。
    if (matchesAt(bytes, NSIS_SIGNATURE, search - 4) && search + 24 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const headerSize = view.getUint32(search + 12, true);
      // 头块大小必须合理：至少容纳 8 个块头 + 最小字符串表；上限防误报。
      if (headerSize >= 64 && headerSize < 1 << 24) {
        return { headerSize, streamStart: search + 20 };
      }
      return null;
    }
    search = bytes.indexOf(magic[0]!, search + 1);
  }
  return null;
}

function matchesAt(bytes: Uint8Array, pattern: Uint8Array, at: number): boolean {
  if (at < 0 || at + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[at + i] !== pattern[i]) return false;
  }
  return true;
}

/** 头块布局：8 个块头 {offset,num} 从 header[4] 起；两种布局（标准
 *  [u32 头长][头块]、flags-first [u32 标志][头块]）的块头起点相同。 */
interface NsisHeaderLayout {
  header: Uint8Array;
  entriesOffset: number;
  entriesNum: number;
  stringsOffset: number;
  langTablesOffset: number;
}

function readNsisHeaderLayout(decoded: Uint8Array): NsisHeaderLayout {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const build = (header: Uint8Array): NsisHeaderLayout | null => {
    if (header.length < 68) return null;
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const blocks: { offset: number; num: number }[] = [];
    for (let i = 0; i < 8; i++) {
      blocks.push({
        offset: headerView.getUint32(4 + i * 8, true),
        num: headerView.getUint32(8 + i * 8, true),
      });
    }
    const entriesBlock = blocks[2]!;
    const stringsOffset = blocks[3]!.offset;
    const langTablesOffset = blocks[4]!.offset;
    if (entriesBlock.num === 0 || entriesBlock.num > 1 << 24) return null;
    if (entriesBlock.offset + entriesBlock.num * NSIS_COMMAND_BYTES > header.length) return null;
    if (langTablesOffset < stringsOffset || langTablesOffset > header.length) return null;
    return {
      header,
      entriesOffset: entriesBlock.offset,
      entriesNum: entriesBlock.num,
      stringsOffset,
      langTablesOffset,
    };
  };
  // 标准布局：u32@0 = 头长，头块在其后。
  const standardSize = view.getUint32(0, true);
  if (standardSize >= 64 && standardSize < 1 << 24 && standardSize + 4 <= decoded.length) {
    const standard = build(decoded.subarray(4, 4 + standardSize));
    if (standard) return standard;
  }
  // flags-first 布局：整段输出即头块（前导 u32 是标志，重打包安装器变体）。
  const flagsFirst = build(decoded);
  if (!flagsFirst) throw new Error('NSIS 头结构无法识别（既非标准也非 flags-first 布局）');
  return flagsFirst;
}

function readNsisString(stringTable: Uint8Array, unicode: boolean, offset: number): string {
  if (offset <= 0 || offset >= stringTable.length) return '';
  const bytes = stringTable.subarray(offset);
  if (unicode) {
    let end = 0;
    while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2;
    return new TextDecoder('utf-16le').decode(bytes.subarray(0, end));
  }
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

/**
 * 从解码后的 solid 输出解析文件列表。offset 指向每文件 u32 长度前缀，
 * 文件内容在 offset+4..offset+4+size。无法识别为 NSIS 头结构时抛错。
 */
export function parseNsisFiles(decoded: Uint8Array): NsisFileEntry[] {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  if (decoded.length < 12) throw new Error('NSIS 解码输出过短');
  const headerSize = view.getUint32(0, true);
  if (headerSize + 4 > decoded.length) throw new Error('NSIS 头长越界');
  const layout = readNsisHeaderLayout(decoded);
  const { header, entriesOffset, entriesNum, stringsOffset, langTablesOffset } = layout;
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const stringTable = header.subarray(stringsOffset, langTablesOffset);
  const unicode = stringTable.length >= 2 && stringTable[0] === 0 && stringTable[1] === 0;

  const dataBase = 4 + headerSize;
  const files: NsisFileEntry[] = [];
  let outPath = '';
  const commands = header.subarray(entriesOffset, entriesOffset + entriesNum * NSIS_COMMAND_BYTES);
  for (let i = 0; i < entriesNum; i++) {
    const which = headerView.getUint32(entriesOffset + i * NSIS_COMMAND_BYTES, true);
    const params = new Int32Array(commands.buffer, commands.byteOffset + i * NSIS_COMMAND_BYTES + 4, 6);
    if (which === EW_CREATEDIR && params[0] === 1) {
      // SetOutPath：后续 ExtractFile 的目录前缀。
      const prefix = readNsisString(stringTable, unicode, params[1]);
      outPath = prefix ? normalizeWindowsPath(prefix) : '';
      continue;
    }
    if (which !== EW_EXTRACTFILE) continue;
    const offset = params[2];
    if (offset < 0 || offset + 4 > decoded.length - dataBase) continue;
    const size = view.getUint32(dataBase + offset, true);
    if (size > decoded.length - dataBase - offset - 4) {
      throw new Error(`NSIS 文件长度越界（${readNsisString(stringTable, unicode, params[1])}）`);
    }
    const name = readNsisString(stringTable, unicode, params[1]);
    const path = normalizeWindowsPath(outPath ? `${outPath}/${name}` : name);
    if (!path) continue;
    files.push({ path, offset: dataBase + offset, size });
  }
  return files;
}

/** NSIS 字符串里的变量标记（$INSTDIR/$TEMP 等，FD 前缀 + 1-2 个非 ASCII 字节；
 *  latin1 解码后这些字节落在 U+0080 以上的任意码位，含 €/¡ 等）。 */
const NSIS_VARIABLE_MARKER = /[\u00fd][^\u0000-\u007f\\/]{1,2}/g;

/** 两段流变体的文件条目：数据不再是 solid 单流，每个文件一条独立 LZMA 流。 */
export interface NsisSplitFile {
  /** 归一化后的客体内路径（变量前缀已剥除）。 */
  path: string;
  /** 该文件数据流 props 相对载荷起点的偏移（容器字节）。 */
  streamOffset: number;
}

/**
 * flags-first 两段流头块的文件枚举：EW_EXTRACTFILE 的 params[2] 不再是
 * solid 数据偏移，而是每个文件独立压缩流的起点偏移（相对首个数据流）。
 */
export function parseNsisSplitHeader(headerDecoded: Uint8Array): NsisSplitFile[] {
  const layout = readNsisHeaderLayout(headerDecoded);
  const { header, entriesOffset, entriesNum, stringsOffset, langTablesOffset } = layout;
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const stringTable = header.subarray(stringsOffset, langTablesOffset);
  const unicode = stringTable.length >= 2 && stringTable[0] === 0 && stringTable[1] === 0;

  const files: NsisSplitFile[] = [];
  let outPath = '';
  const commands = header.subarray(entriesOffset, entriesOffset + entriesNum * NSIS_COMMAND_BYTES);
  for (let i = 0; i < entriesNum; i++) {
    const which = headerView.getUint32(entriesOffset + i * NSIS_COMMAND_BYTES, true);
    const params = new Int32Array(commands.buffer, commands.byteOffset + i * NSIS_COMMAND_BYTES + 4, 6);
    if (which === EW_CREATEDIR && params[0] === 1) {
      const prefix = readNsisString(stringTable, unicode, params[1]).replace(NSIS_VARIABLE_MARKER, '');
      outPath = prefix ? normalizeWindowsPath(prefix) : '';
      continue;
    }
    if (which !== EW_EXTRACTFILE) continue;
    const name = readNsisString(stringTable, unicode, params[1]).replace(NSIS_VARIABLE_MARKER, '');
    if (!name) continue;
    const path = normalizeWindowsPath(outPath ? `${outPath}/${name}` : name);
    if (!path) continue;
    files.push({ path, streamOffset: params[2] });
  }
  return files;
}

export type NsisDecodedArchive =
  | { kind: 'solid'; output: Uint8Array; files: NsisFileEntry[] }
  | { kind: 'split'; payloadStart: number; files: NsisSplitFile[] };

export interface NsisSplitCollectOptions {
  /** 容器字节（两段流：头流之后是每文件独立流）。 */
  bytes: Uint8Array;
  /** 载荷首流 props 的容器偏移（decodeAndParseNsis 返回）。 */
  payloadStart: number;
  files: NsisSplitFile[];
  /** 条目是否参与解码（所需文件或嵌套归档候选）；同偏移重复项只解一次。 */
  isTarget: (path: string) => boolean;
  /** 单条流的解码器（输入已按下一流边界截断，调用方负责 transfer 语义）。 */
  decode: (stream: Uint8Array) => Promise<Uint8Array>;
  /** 收集解码结果；契约错误向上抛，损坏流由本函数拦截并跳过。 */
  collect: (path: string, bytes: Uint8Array) => Promise<void>;
  onStatus?: (message: string) => void;
}

/**
 * 两段流变体逐文件解码：每个文件是独立 LZMA 流，按流偏移只解目标条目。
 * 单条损坏只跳过该文件——不能像 solid 单流一样中断整包，否则排在它后面的
 * 必需资源会一起丢失（实测：YR jb51 安装器 movies01.mix 的桩流损坏，曾导致
 * 其后必需的 ra2md.mix 整个没解出）。必需项缺失由资源验收阶段明确报错。
 * 返回被跳过条目的描述（basename + 原因）。
 */
export async function decodeNsisSplitFiles(options: NsisSplitCollectOptions): Promise<string[]> {
  const { bytes, payloadStart, files, isTarget, decode, collect, onStatus } = options;
  const seenOffsets = new Set<number>();
  const targets = files
    .filter(
      (file) => file.streamOffset >= 0 && !seenOffsets.has(file.streamOffset) && seenOffsets.add(file.streamOffset),
    )
    .filter((file) => isTarget(file.path))
    .sort((a, b) => a.streamOffset - b.streamOffset);
  const skipped: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const file = targets[i]!;
    const next = targets[i + 1];
    // 视图截到下一流 props 再留 EOS 尾余量；transferInput=false 防止
    // 拆走整个 bytes 底层缓冲（后续文件还要继续解码）。
    const end = next ? Math.min(bytes.length, payloadStart + next.streamOffset + 16) : bytes.length;
    const base = file.path.split(/[\\/]/).pop() ?? file.path;
    onStatus?.(`正在解码 NSIS：${base}…`);
    let out: Uint8Array;
    try {
      out = await decode(bytes.subarray(payloadStart + file.streamOffset, end));
    } catch (error) {
      skipped.push(`${base}（${error instanceof Error ? error.message : String(error)}）`);
      onStatus?.(`NSIS 流损坏，跳过：${base}`);
      continue;
    }
    await collect(file.path, out);
  }
  return skipped;
}

/** 头流 EOS 尾分隔（1-8 字节）后定位载荷首流 props。载荷流与头流同一次
 *  压缩设置，props 必须一致——先比对 5 字节 props 再前缀解码 + 第二流连锁
 *  验证，排除随机数据凑巧可解。 */
async function findPayloadStart(
  stream: Uint8Array,
  from: number,
  headerProps: Uint8Array,
  secondOffset: number | undefined,
): Promise<number> {
  const sameProps = (at: number): boolean => {
    for (let i = 0; i < 5; i++) {
      if (stream[at + i] !== headerProps[i]) return false;
    }
    return true;
  };
  for (let k = 0; k < 16; k++) {
    if (!sameProps(from + k)) continue;
    if (secondOffset !== undefined && !sameProps(from + k + secondOffset)) continue;
    try {
      // 小步长前缀解码：确认流真能解（小文件也能过）。
      await decodeLzmaStream({ stream: stream.subarray(from + k), outputSize: 16 });
      if (secondOffset !== undefined) {
        await decodeLzmaStream({ stream: stream.subarray(from + k + secondOffset), outputSize: 16 });
      }
      return from + k;
    } catch {
      /* 候选失败，试下一个偏移 */
    }
  }
  throw new Error('NSIS 载荷起点定位失败（头流后 16 字节内无有效 LZMA 流）');
}

/**
 * 解码 NSIS 并解析文件表：标准 solid 布局返回整段输出与每文件偏移；两段流
 * 变体（重打包安装器：头流 EOS 截断 + 每文件独立压缩流）返回载荷起点与
 * 各流偏移。两种布局的判定：整流解码输出恰好等于头长且输入还有大量剩余。
 */
export async function decodeAndParseNsis(
  bytes: Uint8Array,
  nsis: NsisArchiveInfo,
  onProgress?: (percent: number) => void,
): Promise<NsisDecodedArchive> {
  for (const delta of [0, 4]) {
    const stream = bytes.subarray(nsis.streamStart + delta);
    const prefixOk = await decodeLzmaStream({
      stream,
      outputSize: nsis.headerSize,
      onProgress,
    }).catch(() => null);
    if (!prefixOk) continue;
    const { output, consumed } = await decodeLzmaStreamWithConsumed({ stream, onProgress });
    if (output.length === nsis.headerSize && consumed + 8 < stream.length) {
      // 两段流：头流到 EOS 截断，数据在后续的每文件流里。
      const exact = await decodeLzmaStreamWithConsumed({ stream, outputSize: nsis.headerSize });
      const files = parseNsisSplitHeader(output);
      const sortedOffsets = [...new Set(files.map((file) => file.streamOffset))]
        .filter((offset) => offset >= 0)
        .sort((a, b) => a - b);
      // consumed 含 SDK 补的 13 字节 LZMA-Alone 头，换算回流内偏移再扫描。
      const payloadStart =
        nsis.streamStart +
        delta +
        (await findPayloadStart(stream, exact.consumed - 13, stream.subarray(0, 5), sortedOffsets[1]));
      return { kind: 'split', payloadStart, files };
    }
    return { kind: 'solid', output, files: parseNsisFiles(output) };
  }
  throw new Error('NSIS solid 流解码失败（LZMA 数据损坏）');
}

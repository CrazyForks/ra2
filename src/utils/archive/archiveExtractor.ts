/**
 * 共享归档提取器：NSIS 安装包 / rar / 7z / SFX 自解压 exe → 所需文件。
 *
 * 7z-wasm（7-Zip 官方代码的 WebAssembly 构建，内含 RAR 解码器，原生支持
 * NSIS）在 Worker 内运行，不阻塞主线程；WORKERFS 直接把主线程传来的归档
 * 字节挂进虚拟文件系统，零拷贝。逐文件提取 → postMessage 传出 → unlink，
 * 控制 WASM32 堆峰值。
 *
 * 多层为自适应递归：先列目录（l -slt），只解「所需文件 + 嵌套归档」两类条目
 * （无关文件不进内存，也不会解出安装器杂项报错）；目录里出现的嵌套归档
 * （SFX exe / 内嵌压缩包）逐个继续解，任意子目录都会遍历，递归深度上限 6 层。
 * 目录前缀条目保留目录结构；额外的文件名归位规则由调用方显式提供。
 * 部分 NSIS 变体 7z 只能列出条目名、拿不到压缩载荷尺寸（列表全无 Size），
 * 此时改走 JS 解码（decodeAndParseNsis）直接取文件：标准 solid 整流解码；
 * 重打包安装器为两段流（头流 EOS 截断 + 每文件独立 LZMA 流，头块
 * flags-first 布局），按条目里记录的流偏移只解所需文件。
 */
import SevenZip from '7z-wasm';
import { decodeAndParseNsis, decodeNsisSplitFiles, findNsisArchive } from './nsis';
import { decodeLzmaStream } from './lzmaDecode';
import { archiveExtensionKey } from './archiveFileKey';

export interface ArchiveDirectoryRule {
  directory: string;
  /** 对小写 basename 匹配的正则表达式源码，由调用方配置。 */
  basenamePattern: string;
}

export interface ArchiveExtractRequest {
  type: 'extract';
  /** 归档字节（主线程 transfer 进来）。 */
  buffer?: ArrayBuffer;
  /** 本地 File/Blob 可结构化克隆引用，WORKERFS 按需读取，不先复制整个大包。 */
  archive?: Blob;
  /** 需要的文件名（小写比较；未列出的文件不解出）。 */
  wanted: string[];
  extensions?: string[];
  directoryRules?: readonly ArchiveDirectoryRule[];
  layers?: { required: string[]; startup: string[] };
}

export type ArchiveExtractResponse =
  | { type: 'status'; message: string }
  | { type: 'catalog'; names: string[] }
  | { type: 'startup-ready' }
  | { type: 'file'; name: string; bytes: Uint8Array }
  | { type: 'done'; found: string[] }
  | { type: 'error'; message: string };

// 递归深度上限：exe/7z/zip/rar 链式嵌套（安装包套安装包）也能深入；
// 每层只提取所需文件 + 嵌套归档，上限约束病态炸弹链的层数。
const MAX_LAYERS = 6;
const ARCHIVE_SUFFIXES = ['.rar', '.7z', '.zip', '.exe', '.sfx'];

export interface ArchiveExtractorOptions {
  post: (message: ArchiveExtractResponse, transfer?: Transferable[]) => void;
  locateFile?: (name: string) => string;
  mountInput?: (sevenZip: Awaited<ReturnType<typeof SevenZip>>, request: ArchiveExtractRequest) => void;
  /** 宿主可把输出暂存目录挂到磁盘；浏览器默认使用 MEMFS。 */
  mountOutput?: (sevenZip: Awaited<ReturnType<typeof SevenZip>>) => void;
}

/** 浏览器与 CI 共用解析、嵌套遍历、文件选择和 NSIS 回退；仅输入挂载与输出不同。 */
export function createArchiveExtractor(options: ArchiveExtractorOptions) {
  const post = options.post;
  const urgentFiles = new Set<string>();
  let wakeBackground: (() => void) | undefined;
  return async (request: ArchiveExtractRequest | { type: 'prioritize'; name: string }): Promise<void> => {
    if (request.type === 'prioritize') {
      urgentFiles.add(request.name.toLowerCase());
      wakeBackground?.();
      return;
    }
    const { buffer, archive, wanted, extensions = [], layers } = request;
    const wantedLower = new Set(wanted.map((name) => name.toLowerCase()));
    // 目录前缀条目按小写相对路径匹配并保留目录结构。
    const wantedDirs = new Set([...wantedLower].filter((name) => name.endsWith('/')));
    try {
      const logs: string[] = [];
      const sevenZip = await SevenZip({
        ...(options.locateFile ? { locateFile: options.locateFile } : {}),
        print: (text) => logs.push(String(text)),
        printErr: (text) => logs.push(String(text)),
      });
      const fs = sevenZip.FS;

      fs.mkdir('/work');
      if (options.mountInput) options.mountInput(sevenZip, request);
      else {
        if (!archive && !buffer) throw new Error('缺少归档输入');
        fs.mount(
          sevenZip.WORKERFS,
          { blobs: [{ name: 'archive.bin', data: archive ?? new Blob([buffer!]) }] },
          '/work',
        );
      }
      fs.mkdir('/out');
      options.mountOutput?.(sevenZip);

      const callMain = (args: string[]): number => {
        logs.length = 0;
        try {
          return sevenZip.callMain(args) as unknown as number;
        } catch (error) {
          if (error && (error as { name?: string }).name === 'ExitStatus') {
            return (error as { status: number }).status;
          }
          throw error;
        }
      };

      const isDir = (path: string): boolean => {
        try {
          return fs.isDir(fs.stat(path).mode);
        } catch {
          return false;
        }
      };
      const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;
      const directoryRules = (request.directoryRules ?? [])
        .filter((rule) => wantedDirs.has(rule.directory))
        .map((rule) => ({ directory: rule.directory, pattern: new RegExp(rule.basenamePattern) }));
      /** 所需文件按 basename、目录前缀或调用方归位规则匹配。 */
      const storeKeyOfPath = (path: string): string | null => {
        const extensionKey = archiveExtensionKey(path, extensions);
        if (extensionKey) return extensionKey;
        const lower = path.toLowerCase();
        const base = basename(lower);
        if (wantedLower.has(base)) return base;
        const dir = [...wantedDirs].find((dir) => lower.startsWith(dir));
        if (dir) return lower;
        for (const rule of directoryRules) if (rule.pattern.test(base)) return rule.directory + base;
        return null;
      };
      const readBytes = (path: string): Uint8Array | null => {
        try {
          if (!fs.isFile(fs.stat(path).mode)) return null;
          // FS.readFile 已分配独占 Uint8Array，不再复制一次整份 MIX/嵌套包。
          return fs.readFile(path);
        } catch {
          return null;
        }
      };
      const isArchiveName = (name: string): boolean =>
        ARCHIVE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));

      /** 列出归档条目（l -slt：按空行分记录；无 Size 行的为目录）；非归档返回 null。 */
      const listEntries = (archivePath: string): Array<{ path: string; isDir: boolean; size: number }> | null => {
        if (callMain(['l', '-slt', archivePath]) !== 0) return null;
        const entries: Array<{ path: string; isDir: boolean; size: number }> = [];
        for (const record of logs.join('\n').split(/\n\s*\n/)) {
          const path = record.match(/^Path = (.+)$/m)?.[1]?.trim();
          if (!path) continue;
          const size = record.match(/^Size = (\d+)$/m)?.[1];
          entries.push({ path: path.replace(/\\/g, '/'), isDir: size === undefined, size: Number(size ?? 0) });
        }
        return entries;
      };

      /** DFS 收集目录树内全部文件的相对路径（深度上限防病态目录树）。 */
      const walkFiles = (root: string, prefix = '', depth = 0): string[] => {
        if (depth > 32) return [];
        const result: string[] = [];
        let names: string[];
        try {
          names = fs.readdir(root);
        } catch {
          return [];
        }
        for (const name of names) {
          if (name === '.' || name === '..') continue; // MEMFS readdir 带点条目
          const full = `${root}/${name}`;
          const rel = prefix ? `${prefix}/${name}` : name;
          if (isDir(full)) result.push(...walkFiles(full, rel, depth + 1));
          else result.push(rel);
        }
        return result;
      };

      const found = new Set<string>();
      let extractedBytes = 0;

      /** 归档魔数探测：zip（PK）/ 7z / rar / NSIS 签名（SFX 归档签名可能位于
       *  文件尾，做全量搜索）；普通 MZ 不算归档。 */
      const containsBytes = (haystack: Uint8Array, needle: readonly number[]): boolean => {
        for (let i = 0; i + needle.length <= haystack.length; i++) {
          if (haystack[i] !== needle[0]) continue;
          if (needle.every((byte, offset) => haystack[i + offset] === byte)) return true;
        }
        return false;
      };
      const looksLikeArchive = (bytes: Uint8Array): boolean =>
        containsBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) || // zip / SFX zip
        containsBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || // 7z / SFX 7z
        containsBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || // rar4/5
        containsBytes(
          bytes,
          [...'NullsoftInst'].map((char) => char.charCodeAt(0)),
        ); // NSIS

      /** 处理一层：列目录 → 按需提取 → 收集所需文件。进度按层汇报条目与所获文件；
       *  嵌套归档按「包裹层」启发式继续深入：本层文件很少（安装包套安装包）或
       *  一无所获时下挖，文件众多的目录层视为游戏根目录停止深入；候选归档先经
       *  魔数验证，普通 exe（启动器副本等）不再浪费解包尝试。 */
      const processLayer = async (archivePath: string, outDir: string, depth: number): Promise<void> => {
        const entries = listEntries(archivePath);
        if (!entries) {
          // 顶层必须是可读归档；嵌套层可能是普通 exe 等非归档文件，直接跳过。
          if (depth === 0) throw new Error('无法读取该归档（格式不支持或已损坏）');
          return;
        }
        const solid = logs.some((line) => line.trim() === 'Solid = +');
        const sizeable = entries.filter((entry) => !entry.isDir).length;
        // NSIS 变体判定：超半数条目缺 Size（压缩载荷 7z 无法解析）→ JS 整流解码。
        if (sizeable * 2 < entries.length && (await tryNsisFallback(archivePath, depth))) {
          return;
        }
        const selectedEntries = entries.filter(
          (entry) => !entry.isDir && (storeKeyOfPath(entry.path) !== null || isArchiveName(entry.path)),
        );
        const gameEntries = selectedEntries.filter((entry) => storeKeyOfPath(entry.path) !== null);
        const names = gameEntries.map((entry) => storeKeyOfPath(entry.path)!);
        // 只在目录已完整列出所选本体时发布目录。包裹层继续原有递归，NSIS 整流
        // 回退仍等待完整解码；不能猜尚未探索的内层文件不存在。
        if (
          layers &&
          depth === 0 &&
          !extensions.length &&
          !found.size &&
          sizeable > 3 &&
          layers.required.every((name) => names.includes(name.toLowerCase()))
        ) {
          if (new Set(names).size !== names.length) throw new Error('游戏归档存在同名资源，无法确定覆盖顺序');
          post({ type: 'catalog', names });
          const startupNames = new Set(layers.startup.map((name) => name.toLowerCase()));
          // 空 MIX 占位必须先就绪，不能把“已列出但尚未加载”误认为空电影包。
          const startup = gameEntries.filter(
            (entry) => entry.size === 0 || startupNames.has(storeKeyOfPath(entry.path)!),
          );
          const startupPaths = new Set(startup.map((entry) => entry.path));
          const other = gameEntries.filter((entry) => !startupPaths.has(entry.path)).sort((a, b) => a.size - b.size);
          const extractBatch = (batch: typeof gameEntries): void => {
            if (!batch.length) return;
            const code = callMain([
              'x',
              archivePath,
              `-o${outDir}`,
              '-y',
              '-bso0',
              '-bsp0',
              '--',
              ...batch.map((entry) => entry.path),
            ]);
            if (code !== 0) throw new Error('游戏资源解压失败（损坏、加密或格式不支持）');
            for (const entry of batch) {
              const bytes = readBytes(`${outDir}/${entry.path}`);
              if (!bytes || bytes.length !== entry.size) throw new Error(`解压文件缺失或长度不符：${entry.path}`);
              const name = storeKeyOfPath(entry.path)!;
              post({ type: 'file', name, bytes }, [bytes.buffer]);
              found.add(name);
              fs.unlink(`${outDir}/${entry.path}`);
            }
          };
          post({ type: 'status', message: `正在准备启动层（${startup.length} 个文件）…` });
          extractBatch(startup);
          post({ type: 'startup-ready' });
          post({ type: 'status', message: `启动层已就绪，后台解压其余 ${other.length} 个文件…` });
          // 让出任务边界，使启动就绪消息能先被页面处理；其余资源仍只用一个解压
          // Worker，不同时跑多份大包解码。solid 包分批可能重扫压缩流，不保证提速。
          // 把解压后的 CPU 时间部分让给 VM；真实缺页请求可唤醒等待并调整下个文件。
          // 7z 单次同步解码无法被消息打断，solid 整批仍保留以避免反复重扫压缩流。
          const rest = async (elapsed: number) => {
            if (other.some((entry) => urgentFiles.has(storeKeyOfPath(entry.path)!))) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              return;
            }
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                wakeBackground = undefined;
                resolve();
              };
              const timer = setTimeout(finish, Math.min(100, Math.max(8, elapsed)));
              wakeBackground = finish;
            });
          };
          await rest(32);
          if (solid) extractBatch(other);
          else
            while (other.length) {
              const urgent = other.findIndex((entry) => urgentFiles.has(storeKeyOfPath(entry.path)!));
              const entry = other.splice(urgent >= 0 ? urgent : 0, 1)[0]!;
              urgentFiles.delete(storeKeyOfPath(entry.path)!);
              // 非 solid 可逐文件释放内存并交付，小资源不必等最大影片包解完。
              // solid 仍整批解其他层，避免每个文件都从压缩流开头重扫。
              const started = performance.now();
              extractBatch([entry]);
              await rest(performance.now() - started);
            }
          return;
        }
        const toExtract = selectedEntries.map((entry) => entry.path);
        if (extensions.length && toExtract.length > 4096) throw new Error('附加包文件数量超过 4096 项');
        // 在分配解压内存前检查声明尺寸，包含嵌套归档；不能解完巨包才判断超限。
        extractedBytes += selectedEntries.reduce((sum, entry) => sum + entry.size, 0);
        if (extensions.length && extractedBytes > 128 * 1024 * 1024) throw new Error('附加包累计解压大小超过 128 MB');
        post({
          type: 'status',
          message: `第 ${depth} 层：${sizeable} 个文件${toExtract.length ? `，提取 ${toExtract.length} 个` : ''}…`,
        });
        if (toExtract.length) {
          // 部分条目失败不致命：仍处理已解出的内容。
          const code = callMain(['x', archivePath, `-o${outDir}`, '-y', '-bso0', '-bsp0', '--', ...toExtract]);
          if (extensions.length && code !== 0) throw new Error('附加包解压失败（损坏、加密或格式不支持）');
        }
        // 收集所需文件（可能在子目录里；跨层重名只收第一份）。
        const layerFound: string[] = [];
        for (const rel of walkFiles(outDir)) {
          const storeKey = storeKeyOfPath(rel);
          if (!storeKey) continue;
          if (found.has(storeKey)) {
            // 附加包扁平挂载时，同名文件含义不明确，不能静默选取任意一份。
            if (extensions.length) throw new Error(`压缩包存在同名文件：${storeKey}`);
            fs.unlink(`${outDir}/${rel}`);
            continue;
          }
          const bytes = readBytes(`${outDir}/${rel}`);
          if (!bytes) continue;
          post({ type: 'file', name: storeKey, bytes }, [bytes.buffer]);
          found.add(storeKey);
          layerFound.push(storeKey);
          fs.unlink(`${outDir}/${rel}`);
        }
        if (layerFound.length) {
          post({
            type: 'status',
            message: `第 ${depth} 层找到：${layerFound.slice(0, 8).join('、')}${layerFound.length > 8 ? ` 等 ${layerFound.length} 个` : ''}`,
          });
        }
        if (extensions.length && depth >= MAX_LAYERS && walkFiles(outDir).some(isArchiveName)) {
          throw new Error(`附加包嵌套超过 ${MAX_LAYERS} 层，无法完整探索`);
        }
        // 包裹层判定：文件条目很少或本层一无所获 → 继续下挖；否则视为游戏
        // 根目录（文件众多且已有所获），不再深入嵌套归档。
        if (depth < MAX_LAYERS && (extensions.length > 0 || sizeable <= 3 || layerFound.length === 0)) {
          const nested = walkFiles(outDir)
            .filter((rel) => isArchiveName(basename(rel)))
            .filter((rel) => {
              const bytes = readBytes(`${outDir}/${rel}`);
              return !!bytes && looksLikeArchive(bytes);
            });
          let index = 0;
          for (const rel of nested) {
            post({ type: 'status', message: `第 ${depth + 1} 层解压（${basename(rel)}）…` });
            const sub = `${outDir}/n${depth}_${index++}`;
            fs.mkdir(sub);
            await processLayer(`${outDir}/${rel}`, sub, depth + 1);
          }
        }
        // 收尾：清掉本层全部残留文件（嵌套目录结构留给 worker 退出时回收）。
        for (const rel of walkFiles(outDir)) {
          try {
            fs.unlink(`${outDir}/${rel}`);
          } catch {
            /* 已清 */
          }
        }
      };

      /** JS 整流解码 NSIS（7z 拿不到压缩载荷尺寸的变体）：提取所需文件，
       *  载荷内嵌套归档落盘继续包裹层递归。返回是否接管本层。 */
      const tryNsisFallback = async (archivePath: string, depth: number): Promise<boolean> => {
        const bytes = readBytes(archivePath);
        if (!bytes) return false;
        const nsis = findNsisArchive(bytes);
        if (!nsis) return false;
        if (extensions.length) throw new Error('附加包无法确认解压大小，请先转换为 ZIP 或 7z');
        post({
          type: 'status',
          message: `第 ${depth} 层：7z 无法列出载荷尺寸，改走 NSIS 整流解码（大包约 1-2 分钟）…`,
        });
        try {
          const onProgress = (percent: number): void => {
            if (percent >= 0) post({ type: 'status', message: `正在解码 NSIS：${Math.floor(percent * 100)}%` });
          };
          const decoded = await decodeAndParseNsis(bytes, nsis, onProgress);
          const layerFound: string[] = [];
          let nestedIndex = 0;
          /** 单个文件的统一出口：所需文件直接 post（字节必须复制，不能 transfer
           *  大缓冲的视图）；嵌套归档落盘继续包裹层递归。 */
          const collect = async (path: string, storeKey: string | null, bytesOut: Uint8Array): Promise<void> => {
            if (storeKey) {
              if (found.has(storeKey)) {
                if (extensions.length) throw new Error(`压缩包存在同名文件：${storeKey}`);
                return;
              }
              post({ type: 'file', name: storeKey, bytes: bytesOut }, [bytesOut.buffer]);
              found.add(storeKey);
              layerFound.push(storeKey);
              return;
            }
            if (depth < MAX_LAYERS && isArchiveName(path) && looksLikeArchive(bytesOut)) {
              const base = basename(path);
              const sub = `/out/n${depth}_${nestedIndex++}`;
              fs.mkdir(sub);
              fs.writeFile(`${sub}/${base}`, bytesOut);
              await processLayer(`${sub}/${base}`, sub, depth + 1);
            }
          };
          if (decoded.kind === 'solid') {
            // 标准 solid：subarray 是整段输出大缓冲的视图，postMessage 前必须复制。
            for (const file of decoded.files) {
              const slice = new Uint8Array(decoded.output.subarray(file.offset + 4, file.offset + 4 + file.size));
              await collect(file.path, storeKeyOfPath(file.path), slice);
            }
          } else {
            // 两段流：每文件独立 LZMA 流，按流偏移只解所需文件（含嵌套归档候选）。
            // 同偏移去重（指令流里同一文件可能带不同覆盖标志重复出现）。
            const skippedStreams = await decodeNsisSplitFiles({
              bytes,
              payloadStart: decoded.payloadStart,
              files: decoded.files,
              isTarget: (path) => storeKeyOfPath(path) !== null || isArchiveName(path),
              decode: (stream) => decodeLzmaStream({ stream, onProgress, transferInput: false }),
              collect: (path, out) => collect(path, storeKeyOfPath(path), new Uint8Array(out)),
              onStatus: (message) => post({ type: 'status', message }),
            });
            if (skippedStreams.length) {
              post({
                type: 'status',
                message: `NSIS 跳过 ${skippedStreams.length} 条损坏流：${skippedStreams.slice(0, 3).join('、')}${
                  skippedStreams.length > 3 ? ' 等' : ''
                }`,
              });
            }
          }
          if (layerFound.length) {
            post({
              type: 'status',
              message: `第 ${depth} 层找到：${layerFound.slice(0, 8).join('、')}${layerFound.length > 8 ? ` 等 ${layerFound.length} 个` : ''}`,
            });
          }
          return true;
        } catch (error) {
          if (extensions.length) throw error;
          post({
            type: 'status',
            message: `NSIS 整流解码失败：${error instanceof Error ? error.message : String(error)}`,
          });
          return false;
        }
      };

      await processLayer('/work/archive.bin', '/out', 0);
      post({ type: 'done', found: [...found] });
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
}

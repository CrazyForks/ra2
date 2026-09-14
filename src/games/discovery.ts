export interface GameSourceTransformResult {
  executableBytes: Uint8Array;
  /** 相对游戏根目录的只读覆盖文件。 */
  overlay: ReadonlyMap<string, Uint8Array>;
  label: string;
}

/** 识别安装器/补丁壳并产出可直接启动的游戏文件。 */
export type GameSourceTransform = (bytes: Uint8Array) => Promise<GameSourceTransformResult | null>;

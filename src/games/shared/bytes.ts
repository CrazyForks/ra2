/** 小端 32 位拆成 4 字节。跳板常量与补丁字节序列共用这一处定义：
 *  各游戏模块此前各自复制了一份实现，值一旦不一致不会有测试失败。 */
export const le32 = (value: number): number[] => [0, 8, 16, 24].map((shift) => (value >>> shift) & 255);

/**
 * node:fs/promises 的最小环境声明——测试仅用于读取仓库内资产,
 * 保持 tsconfig types:[] 下也能静态通过。
 */
declare module 'node:fs/promises' {
  export function readFile(path: string | URL, options: string): Promise<string>
}
/**
 * 最小 Node 全局环境声明。
 * 插件运行在 DSH Node.js host,但保持 tsconfig types:[] 不引入 @types/node;
 * 这里只声明我们真正用到的全局,离线即可静态通过。
 */
declare const process: {
  env: Record<string, string | undefined>
}
// vitest 用的空 stub：把 `server-only` / `client-only` 这类 Next 运行时守卫
// 解析到这里（它们在 vite/node 环境无法解析，但在测试里本就是 no-op）。
// 见 vitest.config.ts 的 resolve.alias。
export {};

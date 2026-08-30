// vitest 配置：unit（纯逻辑/全 mock）与 integration（真 fs/子进程，tmpdir 隔离）两层。
// E2E 不走 vitest——它要起 mock 服务器 + PTY 真进程，独立脚本跑（npm run test:e2e）。
// forks 池 = 每个测试文件独立进程：src 的模块级单例（store/config/messages/权限记忆）
// 天然互不污染，无需 reset 样板。tests 里 import 沿用 src 的 `.js` 后缀 ESM 风格。

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // ink/chalk 在 import 时缓存颜色支持——须在 worker 启动前注入（测试内
    // process.env 赋值来不及）。样式码断言（加粗/颜色 ANSI）依赖它。
    // CI=false：ink 检测到 CI 环境时动态区不写出（只存 lastOutput）——GHA runner
    // 自带 CI=true 会传给 vitest worker，app 渲染测试会等不到动态帧。
    env: { FORCE_COLOR: '1', CI: 'false' },
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});

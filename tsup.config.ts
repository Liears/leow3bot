import { defineConfig } from 'tsup';

// 打包配置：把 src/main.tsx bundle 成单文件 ESM（dist/main.mjs），带 shebang。
// 运行时依赖（sharp/ink/react/...）external 化——npm 安装时由 dependencies 自动装，
// bundle 只含 miniclaude 自身代码（对齐 Claude Code 的 cli.js bundle 思路）。
export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: [
    'sharp',
    '@anthropic-ai/sdk',
    /^ink/, // ink / ink-spinner / ink-text-input
    /^react/, // react / react/jsx-runtime
    'gray-matter',
    'turndown',
    '@mixmark-io/domino',
    'strip-ansi',
  ],
  banner: { js: '#!/usr/bin/env node' },
});

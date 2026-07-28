import { defineConfig } from 'tsup';

// 打包配置：把 src/main.tsx bundle 成单文件 ESM（dist/main.mjs），带 shebang。
// 纯 JS 依赖（react/ink/turndown/gray-matter/...）全部 inline 进 bundle，
// 只 external sharp（native libvips 二进制，无法 bundle）。
// 目的：减少运行时 node_modules 小文件 I/O——在 WSL2 /mnt/d 等 I/O 慢的盘上，
// external 几万个碎文件会让启动慢 10s+；inline 成单文件后大幅提速。

// ink 的 devtools.js 静态 import 了 react-devtools-core（optional，未安装）→ stub 成空模块。
const stubOptional = {
  name: 'stub-optional',
  setup(build: any) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub-module',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-module' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

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
  ],
  // tsup 默认会把 package.json 的 dependencies 全部 external。用 noExternal 强制 inline。
  noExternal: [
    /^ink/,
    /^react/,
    /^@anthropic-ai\/sdk/,
    'gray-matter',
    'turndown',
    '@mixmark-io/domino',
    'strip-ansi',
  ],
  // ESM 没有 require，CJS 依赖的 require 调用会触发 esbuild 的 __require 抛错。
  // 注入 createRequire 让 require 可用（对 assert/events 等 bare specifier 兜底）。
  // shebang 加 --no-deprecation：抑制间接依赖（sdk→node-fetch→whatwg-url→punycode）触发的
  // Node DEP0040 弃用警告，CLI 工具不向用户暴露这类 Node 内部噪音。只禁 deprecation 类，保留其它 warning。
  banner: {
    js: '#!/usr/bin/env -S node --no-deprecation\nimport { createRequire as __mc } from "module";\nconst require = __mc(import.meta.url);',
  },
  esbuildPlugins: [stubOptional],
});

/* eslint-env node */
// EveryoneCoding 根 ESLint 配置（ESLint 8 经典配置格式）
// 与 Prettier 无冲突：eslint-config-prettier 必须放在 extends 最后。
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  settings: {
    react: { version: '18' },
  },
  rules: {
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    eqeqeq: ['error', 'smart'],
  },
  overrides: [
    {
      // 测试文件允许 any 与未使用变量占位
      files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    {
      // CLI 脚本（性能基准 / 质量门禁 / 版本与发布编排 / 桌面外壳启动器）：
      // stdout 就是它们的输出界面，因此允许 console（产品代码仍然禁止）。
      files: ['perf/**/*.{ts,mts}', 'ci/**/*.{ts,mts}', 'apps/*/scripts/**/*.{mjs,ts,mts}'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    'target',
    '*.cjs',
    '*.js',
    '.vitest',
    // vitest 加载 .ts 配置时会在配置旁生成 timestamp 临时文件，属产物而非源码
    '**/vitest.config.ts.timestamp-*',
    'apps/desktop-tauri/src-tauri/target',
  ],
};

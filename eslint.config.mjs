import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  {
    // .verify 是本地排查用的草稿目录（已 gitignore），不参与代码规范检查。
    ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'coverage/**', '.verify/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off'
    }
  },
  {
    // 构建脚本（生成图标之类），跑在 Node / Electron 主进程里。
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off'
    }
  },
  {
    // The main process must never spawn processes or reach the network.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'child_process', message: '拾光 从不执行任何命令。' },
            { name: 'node:child_process', message: '拾光 从不执行任何命令。' },
            { name: 'http', message: '本应用必须完全离线。' },
            { name: 'node:http', message: '本应用必须完全离线。' },
            { name: 'https', message: '本应用必须完全离线。' },
            { name: 'node:https', message: '本应用必须完全离线。' },
            { name: 'net', message: '本应用必须完全离线。' },
            { name: 'node:net', message: '本应用必须完全离线。' },
            { name: 'dns', message: '本应用必须完全离线。' },
            { name: 'node:dns', message: '本应用必须完全离线。' }
          ]
        }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '本应用必须完全离线，禁止任何网络请求。' },
        { name: 'XMLHttpRequest', message: '本应用必须完全离线，禁止任何网络请求。' },
        { name: 'WebSocket', message: '本应用必须完全离线，禁止任何网络请求。' },
        { name: 'EventSource', message: '本应用必须完全离线，禁止任何网络请求。' }
      ]
    }
  }
)

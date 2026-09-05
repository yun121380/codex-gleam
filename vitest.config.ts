import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    testTimeout: 20000,
    // 界面上的时间一律按机器本地时区显示（formatListTime / formatDateTime 用的是
    // Date 的本地 getter），所以断言里那些 `08-16 20:50` 只在 +08:00 下成立。
    // 不钉死时区的话，CI 三个 runner 都是 UTC，跑出来的是 `08-16 12:50`。
    // 钉死它是为了让断言有个确定的口径，不是为了绕过时区问题。
    env: { TZ: 'Asia/Shanghai' }
  }
})

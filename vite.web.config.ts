import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "path"

// Web 构建配置（比赛 Demo 专用）
//
// 与桌面端 vite.config.ts 的区别：
// - 不使用 vite-plugin-singlefile（Web 不需要内联单 HTML）
// - 不执行 fixInlineScript（Web 不需要调整内联脚本位置）
// - base: "/"（Vercel 部署在根路径）
// - 输出目录: dist-web（与桌面端 dist 隔离）
// - dev server 配置 /api proxy 到本地 Vercel dev（端口 3000），
//   本地开发时需同时运行 `vercel dev --listen 3000`
export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    port: 5174,
    strictPort: false,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist-web",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html")
      }
    }
  }
})

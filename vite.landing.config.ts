import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { viteSingleFile } from "vite-plugin-singlefile"
import { resolve } from "path"
import { readFileSync, writeFileSync } from "fs"

function fixInlineScript(): Plugin {
  return {
    name: "fix-inline-script",
    applyToEnvironment: () => true,
    closeBundle() {
      const htmlPath = "dist-landing/index.html"
      try {
        let html = readFileSync(htmlPath, "utf-8")
        html = html.replace(/\s+crossorigin/gi, "")
        html = html.replace(/<script type="module">/g, "<script>")
        writeFileSync(htmlPath, html)
      } catch (e) {
        // ignore
      }
    }
  }
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), fixInlineScript()],
  base: "./",
  build: {
    outDir: "dist-landing",
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "landing/index.html")
      }
    }
  }
})

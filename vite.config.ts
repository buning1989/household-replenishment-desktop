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
      const htmlFiles = ["dist/index.html", "dist/landing/index.html"]
      htmlFiles.forEach((htmlPath) => {
        try {
          let html = readFileSync(htmlPath, "utf-8")
          // Remove crossorigin attributes
          html = html.replace(/\s+crossorigin/gi, "")
          // Remove type="module" from inline scripts (not needed after inlining)
          html = html.replace(/<script type="module">/g, "<script>")
          
          // Find the inline script in <head> (not external scripts with src)
          // We need to find <script>...</script> where ... doesn't contain src=
          const headEnd = html.indexOf("</head>")
          if (headEnd === -1) return
          
          const headSection = html.substring(0, headEnd)
          const scriptStartMatch = headSection.match(/<script>([\s\S]*?)<\/script>/)
          
          if (scriptStartMatch && scriptStartMatch.index !== undefined) {
            const scriptStart = scriptStartMatch.index
            const scriptContent = scriptStartMatch[0]
            
            // Remove script from head
            const newHead = headSection.substring(0, scriptStart) + headSection.substring(scriptStart + scriptContent.length)
            html = newHead + html.substring(headEnd)
            
            // Insert script after <div id="root"></div> in body
            // Use indexOf + concatenation instead of replace() to avoid
            // $ special character interpretation in the replacement string
            const rootMarker = '<div id="root"></div>'
            const rootIndex = html.indexOf(rootMarker)
            if (rootIndex !== -1) {
              const afterMarker = rootIndex + rootMarker.length
              html = html.substring(0, afterMarker) + '\n    ' + scriptContent + html.substring(afterMarker)
            }
          }
          
          writeFileSync(htmlPath, html)
        } catch (e) {
          // File might not exist in some build configurations
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), fixInlineScript()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html")
      }
    }
  }
})


// 打包配置完整性测试
//
// 验证 electron-builder 的 files 配置包含 electron/main.js 运行时静态导入的
// 所有本地 .mjs 模块，避免打包后 app.asar 缺失文件导致 ERR_MODULE_NOT_FOUND。
//
// 覆盖：
// 1. scripts/package.mjs 生成的 builderConfig.files 包含 src/shared/**/*.mjs
// 2. package.json 的 build.files 包含 src/shared/**/*.mjs
// 3. electron/main.js 所有本地静态 .mjs import 都能在 files 配置中找到对应规则
// 4. 至少检查以下模块存在于 files 规则覆盖范围：
//    - src/shared/build-mode.mjs
//    - src/shared/demo/demo-reset-core.mjs
//    - electron/budget-notifier.mjs
//
// 这些测试不依赖 app.asar 实际打包，而是验证打包配置本身的正确性。
// 真正的 app.asar 内容验证在打包后通过 `npx asar list` 命令进行。

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

// ---- 读取 package.json 的 build.files ----

function readPackageJsonBuildFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  return pkg.build?.files || []
}

// ---- 读取 scripts/package.mjs 中 builderConfig.files ----

function readPackageMjsBuilderFiles() {
  const content = fs.readFileSync(path.join(root, "scripts/package.mjs"), "utf8")
  // 提取 builderConfig.files 数组
  const match = content.match(/files:\s*\[([\s\S]*?)\]/)
  if (!match) return []
  const arrayContent = match[1]
  // 提取所有字符串字面量
  const strings = arrayContent.match(/"([^"]+)"/g) || []
  return strings.map((s) => s.replace(/"/g, ""))
}

// ---- 解析 electron/main.js 的本地 .mjs 静态 import ----

function parseMainJsLocalMjsImports() {
  const content = fs.readFileSync(path.join(root, "electron/main.js"), "utf8")
  const imports = []
  // 匹配 import ... from "./xxx.mjs" 或 "../xxx.mjs"
  const importRegex = /from\s+["'](\.{1,2}\/[^"']+\.mjs)["']/g
  let match
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1])
  }
  return imports
}

// ---- 判断一个相对 import 路径是否被 files 规则覆盖 ----

function isPathCoveredByFiles(importPath, files) {
  // 标准化 import 路径为相对项目根的路径
  // import 路径相对于 electron/main.js 所在的 electron/ 目录
  const resolved = path.posix.normalize(path.posix.join("electron", importPath))
  // 检查是否匹配任何 file 规则（支持 glob ** 和 *）
  for (const rule of files) {
    if (matchesGlob(resolved, rule)) return true
  }
  return false
}

// 简单 glob 匹配：支持 ** 和 *
function matchesGlob(filePath, pattern) {
  // 转义正则特殊字符（保留 * 用于 glob）
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  // **/ 匹配零或多个路径段（minimatch 语义，**/ 可以匹配空）
  regex = regex.replace(/\*\*\//g, "(?:.*/)?")
  // 剩余的 ** 匹配任意（包括路径分隔符）
  regex = regex.replace(/\*\*/g, ".*")
  // * 匹配非路径分隔符
  regex = regex.replace(/\*/g, "[^/]*")
  return new RegExp("^" + regex + "$").test(filePath)
}

// ---- 测试 ----

describe("打包配置完整性", () => {
  describe("1. package.mjs builderConfig.files 包含 src/shared/**/*.mjs", () => {
    it("files 数组中存在 src/shared/**/*.mjs 规则", () => {
      const files = readPackageMjsBuilderFiles()
      assert.ok(
        files.includes("src/shared/**/*.mjs"),
        `package.mjs 的 files 应包含 "src/shared/**/*.mjs"，实际: ${JSON.stringify(files)}`
      )
    })

    it("files 数组包含必要的基础目录", () => {
      const files = readPackageMjsBuilderFiles()
      assert.ok(files.includes("dist/**/*"), "应包含 dist/**/*")
      assert.ok(files.includes("electron/**/*"), "应包含 electron/**/*")
      assert.ok(files.includes("package.json"), "应包含 package.json")
    })
  })

  describe("2. package.json build.files 包含 src/shared/**/*.mjs", () => {
    it("build.files 数组中存在 src/shared/**/*.mjs 规则", () => {
      const files = readPackageJsonBuildFiles()
      assert.ok(
        files.includes("src/shared/**/*.mjs"),
        `package.json 的 build.files 应包含 "src/shared/**/*.mjs"，实际: ${JSON.stringify(files)}`
      )
    })

    it("build.files 数组包含必要的基础目录", () => {
      const files = readPackageJsonBuildFiles()
      assert.ok(files.includes("dist/**/*"), "应包含 dist/**/*")
      assert.ok(files.includes("electron/**/*"), "应包含 electron/**/*")
      assert.ok(files.includes("package.json"), "应包含 package.json")
    })
  })

  describe("3. electron/main.js 本地 .mjs import 都被 files 规则覆盖", () => {
    it("解析出 main.js 的本地 .mjs import", () => {
      const imports = parseMainJsLocalMjsImports()
      assert.ok(imports.length >= 3, `应至少解析出 3 个本地 .mjs import，实际: ${imports.length}`)
    })

    it("所有 import 都被 package.mjs builderConfig.files 覆盖", () => {
      const files = readPackageMjsBuilderFiles()
      const imports = parseMainJsLocalMjsImports()
      for (const imp of imports) {
        assert.ok(
          isPathCoveredByFiles(imp, files),
          `import "${imp}" 未被 package.mjs 的 files 规则覆盖`
        )
      }
    })

    it("所有 import 都被 package.json build.files 覆盖", () => {
      const files = readPackageJsonBuildFiles()
      const imports = parseMainJsLocalMjsImports()
      for (const imp of imports) {
        assert.ok(
          isPathCoveredByFiles(imp, files),
          `import "${imp}" 未被 package.json build.files 规则覆盖`
        )
      }
    })
  })

  describe("4. 关键运行时模块存在于 files 规则覆盖范围", () => {
    const criticalModules = [
      { importPath: "../src/shared/build-mode.mjs", desc: "src/shared/build-mode.mjs" },
      { importPath: "../src/shared/demo/demo-reset-core.mjs", desc: "src/shared/demo/demo-reset-core.mjs" },
      { importPath: "./budget-notifier.mjs", desc: "electron/budget-notifier.mjs" }
    ]

    for (const { importPath, desc } of criticalModules) {
      it(`package.mjs files 覆盖 ${desc}`, () => {
        const files = readPackageMjsBuilderFiles()
        assert.ok(
          isPathCoveredByFiles(importPath, files),
          `package.mjs files 未覆盖 ${desc}`
        )
      })

      it(`package.json build.files 覆盖 ${desc}`, () => {
        const files = readPackageJsonBuildFiles()
        assert.ok(
          isPathCoveredByFiles(importPath, files),
          `package.json build.files 未覆盖 ${desc}`
        )
      })
    }

    it("关键模块文件在磁盘上实际存在", () => {
      const filesOnDisk = [
        "src/shared/build-mode.mjs",
        "src/shared/demo/demo-reset-core.mjs",
        "src/shared/demo/demo-household-seed.mjs",
        "electron/budget-notifier.mjs",
        "electron/main.js"
      ]
      for (const f of filesOnDisk) {
        assert.ok(
          fs.existsSync(path.join(root, f)),
          `文件 ${f} 在磁盘上不存在`
        )
      }
    })
  })

  describe("5. demo-reset-core.mjs 的依赖链也被覆盖", () => {
    it("demo-reset-core.mjs 导入 demo-household-seed.mjs，需被 src/shared/**/*.mjs 覆盖", () => {
      // demo-reset-core.mjs 导入 ./demo-household-seed.mjs（同目录）
      // 该文件路径为 src/shared/demo/demo-household-seed.mjs
      // src/shared/**/*.mjs 规则应覆盖
      const files = readPackageMjsBuilderFiles()
      assert.ok(files.includes("src/shared/**/*.mjs"))

      const hypotheticalImport = "../src/shared/demo/demo-household-seed.mjs"
      assert.ok(
        isPathCoveredByFiles(hypotheticalImport, files),
        "src/shared/**/*.mjs 应覆盖 demo-household-seed.mjs"
      )
    })
  })

  describe("6. 版本号已升级", () => {
    it("package.json version 为 0.1.4（避免与损坏的 0.1.3 混淆）", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      assert.equal(pkg.version, "0.1.4", "版本号应为 0.1.4")
    })
  })
})

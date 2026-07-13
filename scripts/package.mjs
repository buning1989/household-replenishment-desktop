// 跨平台打包脚本
//
// 用法：
//   node scripts/package.mjs --mode <personal|demo> --target <mac|win> [--arch <arm64|x64>]
//
// 示例：
//   node scripts/package.mjs --mode personal --target mac --arch arm64
//   node scripts/package.mjs --mode personal --target win --arch x64
//   node scripts/package.mjs --mode demo --target mac --arch arm64
//
// 流程：
// 1. 解析参数，校验 mode 和 target
// 2. 生成 electron/build-info.json（主进程启动时读取）
// 3. 运行 typecheck → test → vite build（通过 APP_BUILD_MODE 环境变量注入构建模式到 renderer）
// 4. 生成 electron-builder 配置（根据 mode 设置 appId / productName / name）
// 5. 运行 electron-builder
// 6. 清理临时配置文件
//
// 不依赖 Unix 专属语法，Windows/macOS 均可直接运行。

import { parseArgs } from "node:util"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createBuildInfo, resolveBuildMode } from "../src/shared/build-mode.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "personal" },
    target: { type: "string" },
    arch: { type: "string" },
    "skip-test": { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false }
  }
})

const mode = resolveBuildMode(values.mode)
const target = values.target
const arch = values.arch

if (!target || !["mac", "win"].includes(target)) {
  console.error("用法: node scripts/package.mjs --mode <personal|demo> --target <mac|win> [--arch <arm64|x64>]")
  process.exit(1)
}

// 读取 package.json 获取版本号
function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  return pkg.version || "0.0.0"
}

// 同步执行命令，继承 stdio
function run(cmd, args, env, label) {
  console.log(`\n[package] ${label || `${cmd} ${args.join(" ")}`}`)
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32"
  })
  if (result.status !== 0) {
    console.error(`[package] 命令失败（退出码 ${result.status}）：${cmd} ${args.join(" ")}`)
    process.exit(result.status ?? 1)
  }
}

// 获取平台对应的 npm 命令
function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

// 获取 npx 命令
function npxCmd() {
  return process.platform === "win32" ? "npx.cmd" : "npx"
}

// ---- 1. 生成 build-info.json ----

const buildInfo = createBuildInfo(mode, readVersion())
const buildInfoPath = path.join(root, "electron/build-info.json")
fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2), "utf8")
console.log(`[package] build-info.json 已生成: mode=${buildInfo.mode}, version=${buildInfo.version}`)

// ---- 2. 运行 typecheck + test + build ----

const buildEnv = { APP_BUILD_MODE: mode }

if (!values["skip-build"]) {
  run(npmCmd(), ["run", "typecheck"], buildEnv, "typecheck")

  if (!values["skip-test"]) {
    run(npmCmd(), ["run", "test"], buildEnv, "test")
  }

  // vite build：通过 APP_BUILD_MODE 环境变量注入构建模式
  run(npxCmd(), ["vite", "build"], buildEnv, `vite build (APP_BUILD_MODE=${mode})`)
}

// ---- 3. 生成 electron-builder 配置 ----

const modeConfigs = {
  personal: {
    // Personal 沿用旧正式版应用身份，保证覆盖升级识别和 userData 路径不变
    appId: "cn.home.replenishment",
    productName: "403家庭管家",
    // 不覆盖 extraMetadata.name，使用 package.json 原值 household-replenishment-desktop
    // 这保证 Electron app.getName() 返回旧值，userData 路径不变
    extraMetadata: {},
    winExecutableName: "HouseholdManager403",
    nsisShortcutName: "403家庭管家"
  },
  demo: {
    // Demo 使用独立身份，与个人版完全隔离
    appId: "cn.home.replenishment.demo",
    productName: "403家庭管家 Demo",
    extraMetadata: { name: "household-replenishment-demo" },
    winExecutableName: "HouseholdManager403Demo",
    nsisShortcutName: "403家庭管家 Demo"
  }
}

const modeConfig = modeConfigs[mode]

// 产物目录隔离：personal 和 demo 输出到不同子目录，避免混淆
const targetDir = target === "mac" ? `mac-arm64` : `windows-x64`
const outputDir = `release/${mode}/${targetDir}`

const builderConfig = {
  appId: modeConfig.appId,
  productName: modeConfig.productName,
  extraMetadata: modeConfig.extraMetadata,
  directories: {
    output: outputDir
  },
  files: [
    "dist/**/*",
    "electron/**/*",
    // electron/main.js 运行时静态导入 src/shared 下的 .mjs 模块
    // （build-mode.mjs、demo/demo-reset-core.mjs、demo/demo-household-seed.mjs）
    // 必须打入 app.asar，否则打包后启动报 ERR_MODULE_NOT_FOUND
    "src/shared/**/*.mjs",
    "build/icons/**/*",
    "THIRD_PARTY_NOTICES.md",
    "package.json"
  ],
  mac: {
    icon: "build/icons/icon.icns",
    category: "public.app-category.lifestyle",
    target: ["dmg"]
  },
  win: {
    icon: "build/icons/icon_1024.png",
    executableName: modeConfig.winExecutableName
  },
  nsis: {
    shortcutName: modeConfig.nsisShortcutName,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true
  },
  linux: {
    icon: "build/icons/icon.png"
  }
}

const configPath = path.join(root, "electron-builder.config.json")
fs.writeFileSync(configPath, JSON.stringify(builderConfig, null, 2), "utf8")
console.log(`[package] electron-builder 配置已生成: ${modeConfig.productName} (${modeConfig.appId})`)

// ---- 4. 运行 electron-builder ----

// --publish never：禁用自动发布到 GitHub Release，仅生成本地安装包
const builderArgs = ["electron-builder", "--config", configPath, "--publish", "never"]
const builderEnv = { ...buildEnv }

if (target === "mac") {
  const macArch = arch || "arm64"
  builderArgs.push("--mac", "dmg", `--${macArch}`)
  // macOS 禁用代码签名自动发现（个人使用无需签名）
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false"
} else if (target === "win") {
  const winArch = arch || "x64"
  builderArgs.push("--win", "nsis", `--${winArch}`)
}

run(npxCmd(), builderArgs, builderEnv, `electron-builder --target=${target} --mode=${mode}`)

// ---- 5. 清理临时配置 ----

try {
  fs.unlinkSync(configPath)
} catch {
  // 忽略清理失败
}

console.log(`\n[package] 打包完成: mode=${mode}, target=${target}`)
console.log(`[package] 产物目录: ${path.join(root, outputDir)}`)

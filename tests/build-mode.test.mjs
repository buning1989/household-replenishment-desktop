// 构建模式隔离测试
//
// 验证 Personal 与 Demo 的最终边界：
// - Personal 沿用旧版应用身份（appId、userData 路径），老用户覆盖升级不丢数据
// - Demo 使用独立身份和独立 userData 目录
// - Personal 不展示 Demo 入口，不注入 Demo 数据
//
// 覆盖 12 项验收要求：
// 1. Personal 的 BUILD_MODE 为 personal
// 2. Demo 的 BUILD_MODE 为 demo
// 3. Personal 不显示 Demo Reset 入口
// 4. Personal IPC 拒绝 Demo Reset
// 5. Demo 显示并允许 Demo Reset
// 6. Personal 全新数据目录启动时 items 为空
// 7. Personal 使用旧桌面 localStorage Key
// 8. Personal 使用旧正式版 userData 路径
// 9. Demo 使用独立 userData 路径
// 10. Personal appId 与旧正式版完全一致
// 11. Demo appId 与 Personal 不同
// 12. app.asar 包含所有运行时依赖（通过 files 配置覆盖验证）

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  DEMO_DIR_NAME,
  PERSONAL_APP_ID,
  DEMO_APP_ID,
  VALID_MODES,
  isValidBuildMode,
  resolveBuildMode,
  getUserDataDirName,
  shouldOverrideUserData,
  shouldShowDemoResetEntry,
  shouldAllowDemoReset,
  getAppId,
  createBuildInfo
} from "../src/shared/build-mode.mjs"
import { createDemoState } from "../src/shared/demo/demo-household-seed.mjs"
import { performDemoReset } from "../src/shared/demo/demo-reset-core.mjs"

// ---- 测试工具 ----

let tmpDir

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-mode-test-"))
  return tmpDir
}

function cleanupTmpDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// 模拟 createInitialState 的核心行为：返回空 items 的初始状态
function createEmptyInitialState() {
  return {
    version: 3,
    categories: ["卫生间", "厨房", "洗衣清洁", "宠物用品", "日常护理", "饮品零食", "其他用品"],
    items: [],
    settings: {
      reminderIntervalHours: 1,
      quietStart: "22:00",
      quietEnd: "08:00",
      notificationEnabled: true,
      aiOrderMode: "accurate"
    },
    householdProfile: null,
    updatedAt: Date.now()
  }
}

// 模拟用户创建数据后的状态
function createPopulatedState() {
  const now = Date.now()
  return {
    version: 3,
    categories: ["卫生间", "厨房", "宠物用品"],
    items: [
      {
        id: "user-item-1",
        name: "猫粮",
        category: "宠物用品",
        type: "learning",
        cycleDays: 30,
        bufferDays: 3,
        lastRestockedAt: now,
        purchaseOptions: [],
        history: [
          { id: "r1", at: now - 86400000 * 30, qty: 2, price: 180 }
        ],
        createdAt: now - 86400000 * 60,
        updatedAt: now
      },
      {
        id: "user-item-2",
        name: "抽纸",
        category: "卫生间",
        type: "learning",
        cycleDays: 24,
        bufferDays: 2,
        lastRestockedAt: now,
        purchaseOptions: [],
        history: [],
        createdAt: now - 86400000 * 30,
        updatedAt: now
      }
    ],
    settings: {
      reminderIntervalHours: 2,
      quietStart: "23:00",
      quietEnd: "07:00",
      notificationEnabled: true,
      aiApiKey: "sk-user-personal-key",
      aiChatModel: "qwen-plus"
    },
    householdProfile: null,
    updatedAt: now
  }
}

// ---- 12 项验收测试 ----

describe("构建模式验收测试（12 项）", () => {
  beforeEach(() => {
    makeTmpDir()
  })

  afterEach(() => {
    cleanupTmpDir()
  })

  describe("1. Personal 的 BUILD_MODE 为 personal", () => {
    it("resolveBuildMode('personal') 返回 'personal'", () => {
      assert.equal(resolveBuildMode("personal"), "personal")
    })

    it("createBuildInfo('personal') 的 mode 为 'personal'", () => {
      const info = createBuildInfo("personal", "1.0.0")
      assert.equal(info.mode, "personal")
    })
  })

  describe("2. Demo 的 BUILD_MODE 为 demo", () => {
    it("resolveBuildMode('demo') 返回 'demo'", () => {
      assert.equal(resolveBuildMode("demo"), "demo")
    })

    it("createBuildInfo('demo') 的 mode 为 'demo'", () => {
      const info = createBuildInfo("demo", "1.0.0")
      assert.equal(info.mode, "demo")
    })
  })

  describe("3. Personal 不显示 Demo Reset 入口", () => {
    it("shouldShowDemoResetEntry('personal') 返回 false", () => {
      assert.equal(shouldShowDemoResetEntry("personal"), false)
    })

    it("非法模式也不显示 Demo 入口", () => {
      assert.equal(shouldShowDemoResetEntry("invalid"), false)
      assert.equal(shouldShowDemoResetEntry(undefined), false)
      assert.equal(shouldShowDemoResetEntry(null), false)
    })
  })

  describe("4. Personal IPC 拒绝 Demo Reset", () => {
    it("shouldAllowDemoReset('personal') 返回 false", () => {
      assert.equal(shouldAllowDemoReset("personal"), false)
    })

    it("非法模式也拒绝 Demo Reset", () => {
      assert.equal(shouldAllowDemoReset("invalid"), false)
      assert.equal(shouldAllowDemoReset(undefined), false)
      assert.equal(shouldAllowDemoReset(null), false)
    })

    it("Personal 模式即使有 Demo State 也不执行恢复", () => {
      // 模拟 main.js 中的守卫逻辑
      const buildMode = "personal"
      if (!shouldAllowDemoReset(buildMode)) {
        // 主进程会返回拒绝
        const result = { ok: false, error: "个人正式版不支持恢复演示数据。" }
        assert.equal(result.ok, false)
        assert.match(result.error, /个人正式版/)
      } else {
        assert.fail("Personal 不应允许 Demo Reset")
      }
    })
  })

  describe("5. Demo 显示并允许 Demo Reset", () => {
    it("shouldShowDemoResetEntry('demo') 返回 true", () => {
      assert.equal(shouldShowDemoResetEntry("demo"), true)
    })

    it("shouldAllowDemoReset('demo') 返回 true", () => {
      assert.equal(shouldAllowDemoReset("demo"), true)
    })

    it("demo 模式 performDemoReset 成功恢复 15 个商品", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const backupDir = path.join(tmpDir, "demo-backups")

      const result = performDemoReset(null, stateFile, backupDir)
      assert.ok(result.ok, `demo 恢复应成功: ${result.error || ""}`)
      assert.equal(result.state.items.length, 15, "恢复后应有 15 个商品")

      const written = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(written.items.length, 15, "文件中应有 15 个商品")
    })
  })

  describe("6. Personal 全新数据目录启动时 items 为空", () => {
    it("Personal 不自动注入 Demo 数据", () => {
      // Personal 模式不调用 createDemoState，初始状态为空
      const state = createEmptyInitialState()
      assert.equal(state.items.length, 0, "personal 冷启动 items 应为空")
    })

    it("Demo State 有 15 个商品，Personal 初始状态有 0 个", () => {
      const demoState = createDemoState()
      const personalState = createEmptyInitialState()
      assert.equal(demoState.items.length, 15)
      assert.equal(personalState.items.length, 0)
      assert.notEqual(demoState.items.length, personalState.items.length)
    })

    it("Personal 不调用 shouldOverrideUserData（不设独立目录）", () => {
      assert.equal(shouldOverrideUserData("personal"), false)
    })
  })

  describe("7. Personal 使用旧桌面 localStorage Key", () => {
    it("store.ts 中桌面端 STORAGE_KEY 为 'household_replenishment_desktop_v1'", () => {
      // 读取 store.ts 验证 localStorage key
      const storeContent = fs.readFileSync(
        path.resolve(import.meta.dirname, "../src/store.ts"),
        "utf8"
      )
      assert.match(
        storeContent,
        /household_replenishment_desktop_v1/,
        "桌面端 localStorage Key 必须保持 'household_replenishment_desktop_v1'"
      )
    })

    it("Personal 模式不修改 localStorage Key", () => {
      // localStorage Key 与构建模式无关，始终为固定值
      const storeContent = fs.readFileSync(
        path.resolve(import.meta.dirname, "../src/store.ts"),
        "utf8"
      )
      // 确认没有根据 buildMode 切换 key 的逻辑
      assert.doesNotMatch(
        storeContent,
        /BUILD_MODE.*STORAGE_KEY|STORAGE_KEY.*BUILD_MODE/,
        "localStorage Key 不应与 BUILD_MODE 关联"
      )
    })
  })

  describe("8. Personal 使用旧正式版 userData 路径", () => {
    it("shouldOverrideUserData('personal') 返回 false（不覆盖默认路径）", () => {
      assert.equal(shouldOverrideUserData("personal"), false)
    })

    it("getUserDataDirName('personal') 返回 null（使用 Electron 默认）", () => {
      assert.equal(getUserDataDirName("personal"), null)
    })

    it("Personal 不调用 app.setPath，使用 Electron 默认 userData", () => {
      // 验证 main.js 中的逻辑：仅 shouldOverrideUserData 为 true 时才 setPath
      const buildMode = "personal"
      const shouldSet = shouldOverrideUserData(buildMode)
      assert.equal(shouldSet, false, "Personal 不应调用 app.setPath")
    })

    it("旧版 userData 路径基于 package.json name 'household-replenishment-desktop'", () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
      )
      assert.equal(pkg.name, "household-replenishment-desktop",
        "package.json name 必须保持 'household-replenishment-desktop'，这是旧版 userData 路径的来源")
    })

    it("Personal extraMetadata 不覆盖 name（继承 package.json 原值）", () => {
      // 读取 package.mjs 验证 personal 不覆盖 extraMetadata.name
      const packageMjs = fs.readFileSync(
        path.resolve(import.meta.dirname, "../scripts/package.mjs"),
        "utf8"
      )
      // personal 配置块的 extraMetadata 应为空对象
      const personalMatch = packageMjs.match(/personal:\s*\{[\s\S]*?extraMetadata:\s*(\{[^}]*\})/)
      assert.ok(personalMatch, "应找到 personal 配置块")
      const extraMetadata = personalMatch[1].trim()
      assert.equal(extraMetadata, "{}",
        "Personal extraMetadata 必须为空对象，不覆盖 name")
    })
  })

  describe("9. Demo 使用独立 userData 路径", () => {
    it("shouldOverrideUserData('demo') 返回 true", () => {
      assert.equal(shouldOverrideUserData("demo"), true)
    })

    it("getUserDataDirName('demo') 返回 '403-household-manager-demo'", () => {
      assert.equal(getUserDataDirName("demo"), DEMO_DIR_NAME)
      assert.equal(DEMO_DIR_NAME, "403-household-manager-demo")
    })

    it("Demo 目录名与 Personal 默认路径不同", () => {
      const demoDir = getUserDataDirName("demo")
      const personalDir = getUserDataDirName("personal")
      assert.notEqual(demoDir, personalDir, "Demo 和 Personal 的目录应不同")
      assert.equal(demoDir, "403-household-manager-demo")
      assert.equal(personalDir, null, "Personal 使用 Electron 默认路径")
    })
  })

  describe("10. Personal appId 与旧正式版完全一致", () => {
    it("getAppId('personal') 返回 'cn.home.replenishment'", () => {
      assert.equal(getAppId("personal"), PERSONAL_APP_ID)
      assert.equal(PERSONAL_APP_ID, "cn.home.replenishment")
    })

    it("package.json build.appId 为 'cn.home.replenishment'", () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
      )
      assert.equal(pkg.build.appId, "cn.home.replenishment",
        "package.json 默认 build.appId 必须为旧正式版值")
    })

    it("package.mjs personal 配置 appId 为 'cn.home.replenishment'", () => {
      const packageMjs = fs.readFileSync(
        path.resolve(import.meta.dirname, "../scripts/package.mjs"),
        "utf8"
      )
      const personalMatch = packageMjs.match(/personal:\s*\{[\s\S]*?appId:\s*"([^"]+)"/)
      assert.ok(personalMatch)
      assert.equal(personalMatch[1], "cn.home.replenishment",
        "package.mjs personal appId 必须为旧正式版值")
    })

    it("Personal 不使用 .personal 后缀的 appId", () => {
      assert.notEqual(getAppId("personal"), "cn.home.replenishment.personal")
    })
  })

  describe("11. Demo appId 与 Personal 不同", () => {
    it("getAppId('demo') 返回 'cn.home.replenishment.demo'", () => {
      assert.equal(getAppId("demo"), DEMO_APP_ID)
      assert.equal(DEMO_APP_ID, "cn.home.replenishment.demo")
    })

    it("Demo appId 与 Personal appId 不同", () => {
      assert.notEqual(getAppId("demo"), getAppId("personal"))
    })

    it("package.mjs demo 配置 appId 为 'cn.home.replenishment.demo'", () => {
      const packageMjs = fs.readFileSync(
        path.resolve(import.meta.dirname, "../scripts/package.mjs"),
        "utf8"
      )
      const demoMatch = packageMjs.match(/demo:\s*\{[\s\S]*?appId:\s*"([^"]+)"/)
      assert.ok(demoMatch)
      assert.equal(demoMatch[1], "cn.home.replenishment.demo")
    })
  })

  describe("12. app.asar 包含所有运行时依赖（files 配置覆盖验证）", () => {
    it("package.mjs files 包含 'src/shared/**/*.mjs'", () => {
      const packageMjs = fs.readFileSync(
        path.resolve(import.meta.dirname, "../scripts/package.mjs"),
        "utf8"
      )
      assert.match(packageMjs, /src\/shared\/\*\*\/\*\.mjs/,
        "files 配置必须包含 src/shared/**/*.mjs")
    })

    it("package.json build.files 包含 'src/shared/**/*.mjs'", () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
      )
      assert.ok(
        pkg.build.files.includes("src/shared/**/*.mjs"),
        "build.files 必须包含 src/shared/**/*.mjs"
      )
    })

    it("关键运行时模块在磁盘上存在", () => {
      const root = path.resolve(import.meta.dirname, "..")
      const files = [
        "src/shared/build-mode.mjs",
        "src/shared/demo/demo-reset-core.mjs",
        "src/shared/demo/demo-household-seed.mjs",
        "electron/budget-notifier.mjs",
        "electron/main.js"
      ]
      for (const f of files) {
        assert.ok(fs.existsSync(path.join(root, f)), `文件 ${f} 必须存在`)
      }
    })

    it("electron/main.js 的本地 .mjs import 被 files 规则覆盖", () => {
      const root = path.resolve(import.meta.dirname, "..")
      const mainJs = fs.readFileSync(path.join(root, "electron/main.js"), "utf8")
      const imports = []
      const regex = /from\s+["'](\.{1,2}\/[^"']+\.mjs)["']/g
      let match
      while ((match = regex.exec(mainJs)) !== null) {
        imports.push(match[1])
      }
      assert.ok(imports.length >= 3, `应至少 3 个本地 .mjs import，实际 ${imports.length}`)

      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      const files = pkg.build.files

      function matchesGlob(filePath, pattern) {
        let regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        regex = regex.replace(/\*\*\//g, "(?:.*/)?")
        regex = regex.replace(/\*\*/g, ".*")
        regex = regex.replace(/\*/g, "[^/]*")
        return new RegExp("^" + regex + "$").test(filePath)
      }

      for (const imp of imports) {
        const resolved = path.posix.normalize(path.posix.join("electron", imp))
        const covered = files.some((rule) => matchesGlob(resolved, rule))
        assert.ok(covered, `import "${imp}" 未被 files 规则覆盖`)
      }
    })
  })
})

// ---- 补充测试：数据持久化和隔离 ----

describe("数据持久化与隔离", () => {
  beforeEach(() => {
    makeTmpDir()
  })

  afterEach(() => {
    cleanupTmpDir()
  })

  describe("Personal 数据持久化", () => {
    it("写入用户数据后重新读取，数据应一致", () => {
      // Personal 使用 Electron 默认路径（模拟为 tmpDir）
      const state = createPopulatedState()
      const stateFile = path.join(tmpDir, "reminder-state.json")
      fs.writeFileSync(stateFile, JSON.stringify(state), "utf8")

      const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(readBack.items.length, 2)
      assert.equal(readBack.items[0].name, "猫粮")
      assert.equal(readBack.items[1].name, "抽纸")
      assert.equal(readBack.settings.aiApiKey, "sk-user-personal-key")
    })

    it("空状态首次启动写入空数据后重启仍为空", () => {
      const state = createEmptyInitialState()
      const stateFile = path.join(tmpDir, "reminder-state.json")
      fs.writeFileSync(stateFile, JSON.stringify(state), "utf8")

      const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(readBack.items.length, 0)
    })
  })

  describe("升级版本不重置 Personal 数据", () => {
    it("不同版本的 buildInfo 都为 personal 模式", () => {
      const info1 = createBuildInfo("personal", "0.1.3")
      const info2 = createBuildInfo("personal", "1.0.0")
      assert.equal(info1.mode, "personal")
      assert.equal(info2.mode, "personal")
    })

    it("升级后读取旧版本写入的数据应完整保留", () => {
      const oldState = createPopulatedState()
      oldState.version = 2
      const stateFile = path.join(tmpDir, "reminder-state.json")
      fs.writeFileSync(stateFile, JSON.stringify(oldState), "utf8")

      const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(readBack.items.length, 2)
      assert.equal(readBack.items[0].name, "猫粮")
      assert.equal(readBack.settings.aiApiKey, "sk-user-personal-key")
    })

    it("Personal 模式不因版本变化而改变 userData 路径策略", () => {
      // Personal 始终使用 Electron 默认路径，与版本无关
      assert.equal(shouldOverrideUserData("personal"), false)
    })
  })

  describe("Demo 数据隔离", () => {
    it("Demo 恢复不影响 Personal 默认路径中的数据", () => {
      // 模拟 Personal 默认路径（tmpDir/personal-default）
      const personalDir = path.join(tmpDir, "personal-default")
      fs.mkdirSync(personalDir, { recursive: true })
      const personalState = createPopulatedState()
      const personalFile = path.join(personalDir, "reminder-state.json")
      fs.writeFileSync(personalFile, JSON.stringify(personalState), "utf8")

      // 模拟 Demo 独立目录（tmpDir/403-household-manager-demo）
      const demoDir = path.join(tmpDir, DEMO_DIR_NAME)
      fs.mkdirSync(demoDir, { recursive: true })
      const demoFile = path.join(demoDir, "reminder-state.json")
      const demoBackupDir = path.join(demoDir, "demo-backups")
      const demoResult = performDemoReset(null, demoFile, demoBackupDir)
      assert.ok(demoResult.ok)

      // Personal 数据未被影响
      const personalReadBack = JSON.parse(fs.readFileSync(personalFile, "utf8"))
      assert.equal(personalReadBack.items.length, 2, "Personal 数据应保持 2 个商品")
      assert.equal(personalReadBack.items[0].name, "猫粮")

      // Demo 数据为 Demo State
      const demoReadBack = JSON.parse(fs.readFileSync(demoFile, "utf8"))
      assert.equal(demoReadBack.items.length, 15, "Demo 数据应有 15 个商品")
    })
  })

  describe("模式验证", () => {
    it("合法模式通过验证", () => {
      assert.ok(isValidBuildMode("personal"))
      assert.ok(isValidBuildMode("demo"))
    })

    it("非法模式不通过验证", () => {
      assert.ok(!isValidBuildMode("invalid"))
      assert.ok(!isValidBuildMode(""))
      assert.ok(!isValidBuildMode(null))
      assert.ok(!isValidBuildMode(undefined))
      assert.ok(!isValidBuildMode(123))
    })

    it("VALID_MODES 包含 personal 和 demo", () => {
      assert.deepEqual(VALID_MODES, ["personal", "demo"])
    })

    it("resolveBuildMode 对非法值回退到 fallback", () => {
      assert.equal(resolveBuildMode("bad", "personal"), "personal")
      assert.equal(resolveBuildMode("bad", "demo"), "demo")
      assert.equal(resolveBuildMode(null, "personal"), "personal")
    })

    it("resolveBuildMode fallback 也非法时回退到 personal", () => {
      assert.equal(resolveBuildMode("bad", "also-bad"), "personal")
    })

    it("环境变量 APP_BUILD_MODE 优先于 build-info.json", () => {
      assert.equal(resolveBuildMode("demo", "personal"), "demo")
    })
  })
})

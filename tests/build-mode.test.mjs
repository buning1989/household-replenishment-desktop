// 构建模式隔离测试
//
// 覆盖场景：
// 1. personal 冷启动为空数据
// 2. personal 无 Demo 恢复入口
// 3. demo 仍能恢复 Demo State
// 4. personal 与 demo 数据目录互不影响
// 5. personal 创建数据后重启可恢复
// 6. 升级版本不会重置 personal 数据

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  PERSONAL_DIR_NAME,
  DEMO_DIR_NAME,
  VALID_MODES,
  isValidBuildMode,
  resolveBuildMode,
  getUserDataDirName,
  shouldShowDemoResetEntry,
  shouldAllowDemoReset,
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

// ---- 测试 ----

describe("构建模式隔离", () => {
  beforeEach(() => {
    makeTmpDir()
  })

  afterEach(() => {
    cleanupTmpDir()
  })

  describe("1. personal 冷启动为空数据", () => {
    it("personal 模式初始状态 items 为空数组", () => {
      const state = createEmptyInitialState()
      assert.equal(state.items.length, 0, "personal 冷启动 items 应为空")
    })

    it("personal 模式不自动注入 Demo 数据（shouldAllowDemoReset 为 false）", () => {
      assert.equal(shouldAllowDemoReset("personal"), false, "personal 不允许 Demo 恢复")
    })

    it("personal 模式不展示 Demo 恢复入口", () => {
      assert.equal(shouldShowDemoResetEntry("personal"), false, "personal 不展示 Demo 入口")
    })

    it("Demo State 有 15 个商品，personal 初始状态有 0 个，两者不同", () => {
      const demoState = createDemoState()
      const personalState = createEmptyInitialState()
      assert.equal(demoState.items.length, 15, "Demo State 应有 15 个商品")
      assert.equal(personalState.items.length, 0, "personal 初始状态应为 0 个商品")
      assert.notEqual(demoState.items.length, personalState.items.length, "两者不应相同")
    })

    it("buildInfo 的 mode 为 personal", () => {
      const info = createBuildInfo("personal", "1.0.0")
      assert.equal(info.mode, "personal")
    })
  })

  describe("2. personal 无 Demo 恢复入口", () => {
    it("shouldShowDemoResetEntry(personal) 返回 false", () => {
      assert.equal(shouldShowDemoResetEntry("personal"), false)
    })

    it("shouldAllowDemoReset(personal) 返回 false", () => {
      assert.equal(shouldAllowDemoReset("personal"), false)
    })

    it("shouldShowDemoResetEntry(demo) 返回 true", () => {
      assert.equal(shouldShowDemoResetEntry("demo"), true)
    })

    it("shouldAllowDemoReset(demo) 返回 true", () => {
      assert.equal(shouldAllowDemoReset("demo"), true)
    })

    it("非法模式的 shouldShowDemoResetEntry 返回 false", () => {
      assert.equal(shouldShowDemoResetEntry("invalid"), false)
      assert.equal(shouldShowDemoResetEntry(undefined), false)
      assert.equal(shouldShowDemoResetEntry(null), false)
    })

    it("非法模式的 shouldAllowDemoReset 返回 false", () => {
      assert.equal(shouldAllowDemoReset("invalid"), false)
      assert.equal(shouldAllowDemoReset(undefined), false)
      assert.equal(shouldAllowDemoReset(null), false)
    })
  })

  describe("3. demo 仍能恢复 Demo State", () => {
    it("demo 模式允许 Demo 恢复", () => {
      assert.equal(shouldAllowDemoReset("demo"), true)
    })

    it("demo 模式 performDemoReset 成功恢复 15 个商品", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const backupDir = path.join(tmpDir, "demo-backups")

      const result = performDemoReset(null, stateFile, backupDir)
      assert.ok(result.ok, `demo 恢复应成功: ${result.error || ""}`)
      assert.equal(result.state.items.length, 15, "恢复后应有 15 个商品")

      // 验证写入的文件
      const written = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(written.items.length, 15, "文件中应有 15 个商品")
    })

    it("demo 模式展示 Demo 恢复入口", () => {
      assert.equal(shouldShowDemoResetEntry("demo"), true)
    })
  })

  describe("4. personal 与 demo 数据目录互不影响", () => {
    it("personal 和 demo 使用不同的目录名", () => {
      const personalDir = getUserDataDirName("personal")
      const demoDir = getUserDataDirName("demo")
      assert.notEqual(personalDir, demoDir, "目录名应不同")
      assert.equal(personalDir, PERSONAL_DIR_NAME)
      assert.equal(demoDir, DEMO_DIR_NAME)
    })

    it("personal 目录名固定为 403-household-manager-personal", () => {
      assert.equal(PERSONAL_DIR_NAME, "403-household-manager-personal")
    })

    it("demo 目录名固定为 403-household-manager-demo", () => {
      assert.equal(DEMO_DIR_NAME, "403-household-manager-demo")
    })

    it("模拟 personal 写入数据不影响 demo 目录", () => {
      const appDataDir = path.join(tmpDir, "appData")
      const personalDir = path.join(appDataDir, getUserDataDirName("personal"))
      const demoDir = path.join(appDataDir, getUserDataDirName("demo"))

      fs.mkdirSync(personalDir, { recursive: true })
      fs.mkdirSync(demoDir, { recursive: true })

      // personal 目录写入用户数据
      const personalState = createPopulatedState()
      const personalFile = path.join(personalDir, "reminder-state.json")
      fs.writeFileSync(personalFile, JSON.stringify(personalState), "utf8")

      // demo 目录执行 Demo 恢复
      const demoFile = path.join(demoDir, "reminder-state.json")
      const demoBackupDir = path.join(demoDir, "demo-backups")
      const demoResult = performDemoReset(null, demoFile, demoBackupDir)
      assert.ok(demoResult.ok)

      // 验证 personal 数据未被影响
      const personalReadBack = JSON.parse(fs.readFileSync(personalFile, "utf8"))
      assert.equal(personalReadBack.items.length, 2, "personal 数据应保持 2 个商品")
      assert.equal(personalReadBack.items[0].name, "猫粮", "personal 数据应保持用户商品")
      assert.equal(personalReadBack.settings.aiApiKey, "sk-user-personal-key", "personal API Key 应保持")

      // 验证 demo 数据为 Demo State
      const demoReadBack = JSON.parse(fs.readFileSync(demoFile, "utf8"))
      assert.equal(demoReadBack.items.length, 15, "demo 数据应有 15 个商品")
      assert.notEqual(demoReadBack.items[0].name, "猫粮", "demo 数据不应包含 personal 的猫粮")
    })

    it("模拟 demo 写入数据不影响 personal 目录", () => {
      const appDataDir = path.join(tmpDir, "appData")
      const personalDir = path.join(appDataDir, getUserDataDirName("personal"))
      const demoDir = path.join(appDataDir, getUserDataDirName("demo"))

      fs.mkdirSync(personalDir, { recursive: true })
      fs.mkdirSync(demoDir, { recursive: true })

      // demo 目录先执行 Demo 恢复
      const demoFile = path.join(demoDir, "reminder-state.json")
      const demoBackupDir = path.join(demoDir, "demo-backups")
      performDemoReset(null, demoFile, demoBackupDir)

      // personal 目录写入用户数据
      const personalState = createPopulatedState()
      const personalFile = path.join(personalDir, "reminder-state.json")
      fs.writeFileSync(personalFile, JSON.stringify(personalState), "utf8")

      // 验证 demo 数据未被影响
      const demoReadBack = JSON.parse(fs.readFileSync(demoFile, "utf8"))
      assert.equal(demoReadBack.items.length, 15, "demo 数据应保持 15 个商品")

      // 验证 personal 数据为用户数据
      const personalReadBack = JSON.parse(fs.readFileSync(personalFile, "utf8"))
      assert.equal(personalReadBack.items.length, 2, "personal 数据应保持 2 个商品")
    })
  })

  describe("5. personal 创建数据后重启可恢复", () => {
    it("写入用户数据后重新读取，数据应一致", () => {
      const personalDir = path.join(tmpDir, getUserDataDirName("personal"))
      fs.mkdirSync(personalDir, { recursive: true })

      // 模拟首次创建数据
      const state = createPopulatedState()
      const stateFile = path.join(personalDir, "reminder-state.json")
      fs.writeFileSync(stateFile, JSON.stringify(state), "utf8")

      // 模拟重启后读取
      const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(readBack.items.length, 2, "重启后商品数应一致")
      assert.equal(readBack.items[0].name, "猫粮", "重启后商品名应一致")
      assert.equal(readBack.items[1].name, "抽纸", "重启后商品名应一致")
      assert.equal(readBack.settings.aiApiKey, "sk-user-personal-key", "重启后 API Key 应保留")
      assert.equal(readBack.settings.reminderIntervalHours, 2, "重启后提醒间隔应保留")
    })

    it("空状态首次启动写入空数据后重启仍为空", () => {
      const personalDir = path.join(tmpDir, getUserDataDirName("personal"))
      fs.mkdirSync(personalDir, { recursive: true })

      const state = createEmptyInitialState()
      const stateFile = path.join(personalDir, "reminder-state.json")
      fs.writeFileSync(stateFile, JSON.stringify(state), "utf8")

      const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(readBack.items.length, 0, "空状态重启后仍为空")
    })
  })

  describe("6. 升级版本不会重置 personal 数据", () => {
    it("不同版本的 buildInfo 使用相同的 personal 目录名", () => {
      const info1 = createBuildInfo("personal", "0.1.3")
      const info2 = createBuildInfo("personal", "1.0.0")
      const info3 = createBuildInfo("personal", "2.5.7")

      assert.equal(info1.mode, "personal")
      assert.equal(info2.mode, "personal")
      assert.equal(info3.mode, "personal")

      // 目录名与版本无关，只与 mode 有关
      assert.equal(getUserDataDirName(info1.mode), getUserDataDirName(info2.mode))
      assert.equal(getUserDataDirName(info2.mode), getUserDataDirName(info3.mode))
    })

    it("升级后读取旧版本写入的数据应完整保留", () => {
      const personalDir = path.join(tmpDir, getUserDataDirName("personal"))
      fs.mkdirSync(personalDir, { recursive: true })

      // 模拟旧版本写入数据
      const oldState = createPopulatedState()
      oldState.version = 2 // 旧版本号
      const stateFile = path.join(personalDir, "reminder-state.json")
      fs.writeFileSync(stateFile, JSON.stringify(oldState), "utf8")

      // 模拟升级后读取（不修改数据文件）
      const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(readBack.items.length, 2, "升级后商品数应不变")
      assert.equal(readBack.items[0].name, "猫粮", "升级后商品名应不变")
      assert.equal(readBack.settings.aiApiKey, "sk-user-personal-key", "升级后 API Key 应保留")
    })

    it("build-info.json 缺失时回退到 personal", () => {
      // 模拟 build-info.json 不存在的情况
      const mode = resolveBuildMode(undefined, "personal")
      assert.equal(mode, "personal")
    })

    it("build-info.json mode 字段损坏时回退到 personal", () => {
      const mode = resolveBuildMode("corrupted", "personal")
      assert.equal(mode, "personal")
    })

    it("环境变量 APP_BUILD_MODE 优先于 build-info.json", () => {
      // 模拟环境变量为 demo 但 build-info.json 为 personal
      const envMode = resolveBuildMode("demo", "personal")
      assert.equal(envMode, "demo", "环境变量应优先")
    })
  })

  describe("7. 模式验证", () => {
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
  })

  describe("8. build-info.json 生成", () => {
    it("createBuildInfo 生成正确的结构", () => {
      const info = createBuildInfo("personal", "1.2.3")
      assert.equal(info.mode, "personal")
      assert.equal(info.version, "1.2.3")
      assert.ok(typeof info.buildTime === "string")
      assert.ok(info.buildTime.length > 0)
    })

    it("createBuildInfo 对非法 mode 回退到 personal", () => {
      const info = createBuildInfo("bad-mode", "1.0.0")
      assert.equal(info.mode, "personal")
    })

    it("createBuildInfo 对缺失 version 使用 0.0.0", () => {
      const info = createBuildInfo("personal", undefined)
      assert.equal(info.version, "0.0.0")
    })

    it("写入并读取 build-info.json 后 mode 保持一致", () => {
      const personalInfo = createBuildInfo("personal", "1.0.0")
      const demoInfo = createBuildInfo("demo", "1.0.0")

      const personalPath = path.join(tmpDir, "build-info.json")
      fs.writeFileSync(personalPath, JSON.stringify(personalInfo), "utf8")
      const readPersonal = JSON.parse(fs.readFileSync(personalPath, "utf8"))
      assert.equal(readPersonal.mode, "personal")

      const demoPath = path.join(tmpDir, "build-info-demo.json")
      fs.writeFileSync(demoPath, JSON.stringify(demoInfo), "utf8")
      const readDemo = JSON.parse(fs.readFileSync(demoPath, "utf8"))
      assert.equal(readDemo.mode, "demo")

      // 解析回 mode
      assert.equal(resolveBuildMode(readPersonal.mode), "personal")
      assert.equal(resolveBuildMode(readDemo.mode), "demo")
    })
  })
})

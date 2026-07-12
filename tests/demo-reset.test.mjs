// Demo Reset 核心逻辑测试
//
// 测试覆盖：
// 1. 非空旧状态恢复
// 2. 配置保留（API Key、模型配置）
// 3. 洗衣凝珠不存在
// 4. 重复恢复不产生重复数据
// 5. 备份创建与清理
// 6. 恢复中断回滚

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  extractPreservedSettings,
  mergePreservedSettings,
  prepareDemoResetState,
  createBackup,
  atomicWriteState,
  findLatestBackup,
  restoreFromBackup,
  verifyDemoState,
  performDemoReset,
  backupFileName
} from "../src/shared/demo/demo-reset-core.mjs"
import { createDemoState, DEMO_ASSERTIONS } from "../src/shared/demo/demo-household-seed.mjs"

// ---- 测试工具 ----

function createOldState() {
  return {
    version: 3,
    categories: ["水电煤", "其他", "宠物用品", "洗衣清洁"],
    items: [
      {
        id: "old-item-1",
        name: "电费",
        category: "水电煤",
        unit: "度",
        cycleDays: 100,
        bufferDays: 3,
        lastRestockedAt: Date.now(),
        history: [{ id: "r1", at: Date.now(), qty: 60, price: 100 }],
        purchaseOptions: [],
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now()
      },
      {
        id: "old-item-2",
        name: "狗粮",
        category: "宠物用品",
        unit: "袋",
        cycleDays: 30,
        bufferDays: 2,
        lastRestockedAt: Date.now(),
        history: [{ id: "r2", at: Date.now(), qty: 1, price: 300 }],
        purchaseOptions: [],
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now()
      },
      {
        id: "old-item-3",
        name: "洗衣凝珠",
        category: "洗衣清洁",
        unit: "袋",
        cycleDays: 15,
        bufferDays: 2,
        lastRestockedAt: Date.now(),
        history: [],
        purchaseOptions: [],
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now()
      },
      {
        id: "old-item-4",
        name: "猫砂",
        category: "宠物用品",
        unit: "袋",
        cycleDays: 14,
        bufferDays: 2,
        lastRestockedAt: Date.now(),
        history: [{ id: "r3", at: Date.now(), qty: 5, price: 110 }],
        purchaseOptions: [],
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now()
      }
    ],
    settings: {
      reminderIntervalHours: 5,
      quietStart: "23:00",
      quietEnd: "07:00",
      notificationEnabled: false,
      monthlyBudget: 5000,
      aiApiKey: "sk-test-secret-key-12345",
      aiChatModel: "qwen3.7-plus",
      aiOrderModel: "qwen3-vl-flash",
      aiOrderMode: "fast"
    },
    householdProfile: null,
    updatedAt: Date.now()
  }
}

// ---- 临时目录管理 ----

let tmpDir

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-reset-test-"))
  return tmpDir
}

function cleanupTmpDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---- 测试 ----

describe("Demo Reset Core", () => {
  beforeEach(() => {
    makeTmpDir()
  })

  afterEach(() => {
    cleanupTmpDir()
  })

  describe("1. 非空旧状态恢复", () => {
    it("应清除所有旧商品并替换为 Demo 15 个商品", () => {
      const oldState = createOldState()
      const result = prepareDemoResetState(oldState)

      assert.equal(result.items.length, 15, "商品数应为 15")
      assert.equal(result.categories.length, 7, "分类数应为 7")

      // 旧商品不存在
      assert.equal(result.items.find((i) => i.name === "电费"), undefined, "电费应不存在")
      assert.equal(result.items.find((i) => i.name === "狗粮"), undefined, "狗粮应不存在")

      // 旧猫砂被 Demo 猫砂替换
      const catLitter = result.items.find((i) => i.name === "猫砂")
      assert.ok(catLitter, "猫砂应存在")
      assert.equal(catLitter.id, "demo-cat-litter", "猫砂应为 Demo ID")
      assert.notEqual(catLitter.id, "old-item-4", "旧猫砂 ID 不应保留")
    })

    it("洗衣凝珠应不存在", () => {
      const oldState = createOldState()
      assert.ok(oldState.items.some((i) => i.name === "洗衣凝珠"), "旧状态应包含洗衣凝珠")

      const result = prepareDemoResetState(oldState)
      assert.equal(result.items.find((i) => i.name === "洗衣凝珠"), undefined, "恢复后洗衣凝珠应不存在")
    })

    it("核心商品都应存在", () => {
      const result = prepareDemoResetState(createOldState())
      for (const name of ["猫砂", "洗衣液", "宠物擦脚湿巾", "抽纸", "垃圾袋"]) {
        assert.ok(result.items.find((i) => i.name === name), `${name} 应存在`)
      }
    })
  })

  describe("2. 配置保留", () => {
    it("应保留 API Key 和模型配置", () => {
      const oldState = createOldState()
      const result = prepareDemoResetState(oldState)

      assert.equal(result.settings.aiApiKey, "sk-test-secret-key-12345", "API Key 应保留")
      assert.equal(result.settings.aiChatModel, "qwen3.7-plus", "aiChatModel 应保留")
      assert.equal(result.settings.aiOrderModel, "qwen3-vl-flash", "aiOrderModel 应保留")
    })

    it("应保留通知设置", () => {
      const oldState = createOldState()
      const result = prepareDemoResetState(oldState)

      assert.equal(result.settings.notificationEnabled, false, "notificationEnabled 应保留")
      assert.equal(result.settings.reminderIntervalHours, 5, "reminderIntervalHours 应保留")
      assert.equal(result.settings.quietStart, "23:00", "quietStart 应保留")
      assert.equal(result.settings.quietEnd, "07:00", "quietEnd 应保留")
    })

    it("Demo Seed 文件中不存在真实 API Key", () => {
      const demoState = createDemoState()
      assert.equal(demoState.settings.aiApiKey, undefined, "Demo Seed 不应包含 aiApiKey")
      assert.equal(demoState.settings.aiChatModel, undefined, "Demo Seed 不应包含 aiChatModel")
      assert.equal(demoState.settings.aiOrderModel, undefined, "Demo Seed 不应包含 aiOrderModel")
    })

    it("空状态恢复时不应崩溃", () => {
      const result = prepareDemoResetState(null)
      assert.equal(result.items.length, 15)
      assert.equal(result.settings.aiApiKey, undefined)
    })
  })

  describe("3. 重复恢复", () => {
    it("连续恢复 3 次应保持数据一致", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const backupDir = path.join(tmpDir, "demo-backups")

      let currentState = createOldState()

      for (let i = 0; i < 3; i++) {
        const result = performDemoReset(currentState, stateFile, backupDir, Date.now() + i * 1000)
        assert.ok(result.ok, `第 ${i + 1} 次恢复应成功: ${result.error || ""}`)

        // 读取写入的 state 作为下次的 current
        const written = JSON.parse(fs.readFileSync(stateFile, "utf8"))
        currentState = written

        // 每次都是 15 个商品
        assert.equal(currentState.items.length, 15, `第 ${i + 1} 次商品数应为 15`)

        // 补货记录总数一致
        const historyCount = currentState.items.reduce((sum, item) => sum + item.history.length, 0)
        assert.ok(
          historyCount >= DEMO_ASSERTIONS.minHistoryCount && historyCount <= DEMO_ASSERTIONS.maxHistoryCount,
          `第 ${i + 1} 次补货记录数应在 ${DEMO_ASSERTIONS.minHistoryCount}-${DEMO_ASSERTIONS.maxHistoryCount} 范围内，实际 ${historyCount}`
        )

        // 不存在重复商品
        const names = currentState.items.map((i) => i.name)
        const dupes = names.filter((n, idx) => names.indexOf(n) !== idx)
        assert.equal(dupes.length, 0, `第 ${i + 1} 次不应有重复商品`)

        // 不存在重复补货记录 ID
        const allRecordIds = currentState.items.flatMap((i) => i.history.map((h) => h.id))
        const dupeRecords = allRecordIds.filter((id, idx) => allRecordIds.indexOf(id) !== idx)
        assert.equal(dupeRecords.length, 0, `第 ${i + 1} 次不应有重复补货记录`)
      }
    })

    it("重复恢复后备份应最多保留 3 份", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const backupDir = path.join(tmpDir, "demo-backups")

      for (let i = 0; i < 5; i++) {
        performDemoReset(createOldState(), stateFile, backupDir, Date.now() + i * 10000)
      }

      const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith("state-before-demo-reset-"))
      assert.ok(backups.length <= 3, `备份应最多 3 份，实际 ${backups.length}`)
    })
  })

  describe("4. pending 状态清理", () => {
    it("恢复后 lastAgentMutation 应被清除", () => {
      const oldState = createOldState()
      oldState.lastAgentMutation = {
        mutationType: "createItem",
        createdAt: Date.now(),
        itemId: "old-item-3",
        itemName: "洗衣凝珠",
        afterSnapshot: { id: "old-item-3" },
        consumed: false
      }

      const result = prepareDemoResetState(oldState)
      assert.equal(result.lastAgentMutation, undefined, "lastAgentMutation 应被清除")
    })

    it("恢复后 settings.lastChatSessionAt 应被清除", () => {
      const oldState = createOldState()
      oldState.settings.lastChatSessionAt = Date.now()

      const result = prepareDemoResetState(oldState)
      assert.equal(result.settings.lastChatSessionAt, undefined, "lastChatSessionAt 应被清除")
    })
  })

  describe("5. 备份与回滚", () => {
    it("应创建备份文件", () => {
      const oldState = createOldState()
      const backupDir = path.join(tmpDir, "demo-backups")
      const result = createBackup(oldState, backupDir)

      assert.ok(result.ok, "备份应成功")
      assert.ok(fs.existsSync(result.path), "备份文件应存在")

      const backed = JSON.parse(fs.readFileSync(result.path, "utf8"))
      assert.equal(backed.items.length, oldState.items.length, "备份内容应与原状态一致")
    })

    it("备份文件名应包含时间戳", () => {
      const name = backupFileName(new Date(2026, 6, 12, 18, 30, 0).getTime())
      assert.match(name, /state-before-demo-reset-20260712-183000\.json/)
    })

    it("写入失败时应自动回滚", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const backupDir = path.join(tmpDir, "demo-backups")

      // 先正常恢复一次，创建备份
      const first = performDemoReset(createOldState(), stateFile, backupDir)
      assert.ok(first.ok)

      // 读取备份前的 state
      const beforeState = JSON.parse(fs.readFileSync(stateFile, "utf8"))

      // 将 state 文件设为只读目录（模拟写入失败）
      // 注意：我们用不可写路径来模拟失败
      const readOnlyDir = path.join(tmpDir, "readonly")
      fs.mkdirSync(readOnlyDir, { recursive: true })
      fs.chmodSync(readOnlyDir, 0o444)
      const readOnlyStateFile = path.join(readOnlyDir, "reminder-state.json")

      const result = performDemoReset(beforeState, readOnlyStateFile, backupDir)
      assert.ok(!result.ok, "恢复应失败")

      // 恢复目录权限以便清理
      fs.chmodSync(readOnlyDir, 0o755)

      // 原文件应未被破坏
      const afterState = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(afterState.items.length, beforeState.items.length, "原 state 应未被破坏")
    })

    it("performDemoReset 完整流程应成功", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const backupDir = path.join(tmpDir, "demo-backups")
      const oldState = createOldState()

      const result = performDemoReset(oldState, stateFile, backupDir)
      assert.ok(result.ok, `恢复应成功: ${result.error || ""}`)
      assert.ok(result.state, "应返回新 state")
      assert.ok(result.backupPath, "应返回备份路径")

      // 验证写入的文件
      const written = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(written.items.length, 15)
      assert.equal(written.settings.aiApiKey, "sk-test-secret-key-12345")

      // 验证备份文件
      assert.ok(fs.existsSync(result.backupPath))
      const backup = JSON.parse(fs.readFileSync(result.backupPath, "utf8"))
      assert.equal(backup.items.length, oldState.items.length, "备份应包含旧数据")
    })
  })

  describe("6. 内联验证", () => {
    it("正确的 Demo State 应通过验证", () => {
      const demoState = createDemoState()
      const result = verifyDemoState(demoState)
      assert.ok(result.ok, `验证应通过: ${result.errors.join(", ")}`)
    })

    it("缺少商品应验证失败", () => {
      const demoState = createDemoState()
      demoState.items = demoState.items.slice(0, 10)
      const result = verifyDemoState(demoState)
      assert.ok(!result.ok, "验证应失败")
      assert.ok(result.errors.some((e) => e.includes("商品数量")))
    })

    it("存在洗衣凝珠应验证失败", () => {
      const demoState = createDemoState()
      demoState.items.push({ id: "x", name: "洗衣凝珠", history: [] })
      const result = verifyDemoState(demoState)
      assert.ok(!result.ok, "验证应失败")
      assert.ok(result.errors.some((e) => e.includes("洗衣凝珠")))
    })
  })

  describe("7. updatedAt 确保胜出", () => {
    it("恢复后 updatedAt 应大于旧 state", () => {
      const oldState = createOldState()
      const now = Date.now()
      const result = prepareDemoResetState(oldState, now)

      assert.ok(result.updatedAt >= now, "updatedAt 应为当前时间")
      assert.ok(result.updatedAt >= oldState.updatedAt, "updatedAt 应不小于旧 state")
    })

    it("reconcileState 场景：Demo State updatedAt 胜出", () => {
      // 模拟 reconcileState 的比较逻辑：
      // return remoteState.updatedAt > localState.updatedAt ? remoteState : localState
      const oldState = createOldState()
      const fixedNow = Date.now() + 10000 // 确保大于 oldState.updatedAt
      const demoState = prepareDemoResetState(oldState, fixedNow)

      // Demo State (作为 remote) vs 旧 state (作为 local)
      const winner = demoState.updatedAt > oldState.updatedAt ? demoState : oldState
      assert.equal(winner, demoState, "Demo State 应在 reconcileState 中胜出")
    })
  })

  describe("8. atomicWriteState", () => {
    it("应原子写入 state 文件", () => {
      const stateFile = path.join(tmpDir, "reminder-state.json")
      const demoState = createDemoState()

      const result = atomicWriteState(stateFile, demoState)
      assert.ok(result.ok, "原子写入应成功")
      assert.ok(fs.existsSync(stateFile), "文件应存在")

      // 不应残留 .tmp 文件
      assert.ok(!fs.existsSync(stateFile + ".tmp"), "不应残留 .tmp 文件")

      // 内容正确
      const written = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      assert.equal(written.items.length, 15)
    })
  })
})

// 构建模式共享逻辑
//
// 被 electron/main.js（主进程）、scripts/package.mjs（打包脚本）和 tests 共同复用。
// 不依赖 React、Electron 或任何运行时环境，仅做纯计算。
//
// 模式说明：
// - personal：个人正式使用版。继承旧版应用身份（appId、应用名、userData 路径），
//   老用户覆盖安装后可直接读取原有数据。不注入任何 Demo/Seed/Fixture 数据，
//   不展示"恢复 Demo State"入口，不允许通过 IPC 触发 Demo 数据恢复。
// - demo：比赛演示版。使用独立 appId 和独立 userData 目录，与个人版完全隔离。
//   保留现有 Demo State 和一键恢复能力。
//
// 数据目录策略：
// - personal → 不覆盖 userData，使用 Electron 默认路径（由 app.getName() 决定）
// - demo     → 403-household-manager-demo（独立目录，不影响个人版数据）

/** demo 模式固定数据目录名（personal 模式不使用独立目录） */
export const DEMO_DIR_NAME = "403-household-manager-demo"

/** 旧正式版 appId（Personal 必须沿用，保证升级识别） */
export const PERSONAL_APP_ID = "cn.home.replenishment"

/** Demo 版 appId（独立身份） */
export const DEMO_APP_ID = "cn.home.replenishment.demo"

/** 合法的构建模式 */
export const VALID_MODES = ["personal", "demo"]

/**
 * 判断构建模式字符串是否合法。
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isValidBuildMode(mode) {
  return typeof mode === "string" && VALID_MODES.includes(mode)
}

/**
 * 解析构建模式。非法或缺失时回退到 fallback。
 * @param {unknown} value - 环境变量或 build-info.json 中的 mode 值
 * @param {"personal" | "demo"} [fallback="personal"] - 回退模式
 * @returns {"personal" | "demo"}
 */
export function resolveBuildMode(value, fallback = "personal") {
  if (isValidBuildMode(value)) return /** @type {"personal" | "demo"} */ (value)
  return isValidBuildMode(fallback) ? fallback : "personal"
}

/**
 * 是否需要覆盖 Electron 默认 userData 路径。
 * - personal：返回 false，使用 Electron 默认路径（继承旧版数据）
 * - demo：返回 true，使用独立目录
 * @param {"personal" | "demo"} mode
 * @returns {boolean}
 */
export function shouldOverrideUserData(mode) {
  return mode === "demo"
}

/**
 * 根据 demo 模式返回独立的 userData 目录名。
 * 仅 demo 模式有值；personal 模式返回 null（表示使用 Electron 默认）。
 * @param {"personal" | "demo"} mode
 * @returns {string | null}
 */
export function getUserDataDirName(mode) {
  return mode === "demo" ? DEMO_DIR_NAME : null
}

/**
 * 是否展示"恢复 Demo State"入口。
 * 仅 demo 模式返回 true。
 * @param {"personal" | "demo"} mode
 * @returns {boolean}
 */
export function shouldShowDemoResetEntry(mode) {
  return mode === "demo"
}

/**
 * 是否允许通过 IPC 执行 Demo 数据恢复。
 * 仅 demo 模式返回 true。personal 模式主进程会拒绝调用。
 * @param {"personal" | "demo"} mode
 * @returns {boolean}
 */
export function shouldAllowDemoReset(mode) {
  return mode === "demo"
}

/**
 * 根据构建模式返回 appId。
 * - personal：沿用旧正式版 appId（cn.home.replenishment）
 * - demo：使用独立 appId（cn.home.replenishment.demo）
 * @param {"personal" | "demo"} mode
 * @returns {string}
 */
export function getAppId(mode) {
  return mode === "demo" ? DEMO_APP_ID : PERSONAL_APP_ID
}

/**
 * 生成 build-info.json 内容。
 * @param {"personal" | "demo"} mode
 * @param {string} version
 * @returns {{ mode: string, version: string, buildTime: string }}
 */
export function createBuildInfo(mode, version) {
  return {
    mode: resolveBuildMode(mode),
    version: typeof version === "string" ? version : "0.0.0",
    buildTime: new Date().toISOString()
  }
}

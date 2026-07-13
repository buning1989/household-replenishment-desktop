// 构建模式共享逻辑
//
// 被 electron/main.js（主进程）、scripts/package.mjs（打包脚本）和 tests 共同复用。
// 不依赖 React、Electron 或任何运行时环境，仅做纯计算。
//
// 模式说明：
// - personal：个人正式使用版。首次启动数据为空，不注入任何 Demo/Seed/Fixture 数据，
//   不展示"恢复 Demo State"入口，不允许通过 IPC 触发 Demo 数据恢复。
// - demo：比赛演示版。保留现有 Demo State 和一键恢复能力。
//
// 数据目录隔离：
// - personal → 403-household-manager-personal
// - demo     → 403-household-manager-demo
// 两个目录互不影响，覆盖安装和版本升级时始终使用同一目录。

/** personal 模式固定数据目录名 */
export const PERSONAL_DIR_NAME = "403-household-manager-personal"

/** demo 模式固定数据目录名 */
export const DEMO_DIR_NAME = "403-household-manager-demo"

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
 * 根据构建模式返回固定的 userData 目录名。
 * @param {"personal" | "demo"} mode
 * @returns {string}
 */
export function getUserDataDirName(mode) {
  return mode === "demo" ? DEMO_DIR_NAME : PERSONAL_DIR_NAME
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

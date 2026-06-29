import { spawn } from "node:child_process"
import net from "node:net"
import process from "node:process"

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const electronBinary = process.platform === "win32"
  ? "node_modules/.bin/electron.cmd"
  : "node_modules/.bin/electron"
const devPort = 5173
const devHost = "127.0.0.1"

function isPortOpen(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host })
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

if (await isPortOpen(devPort, devHost)) {
  console.error(`开发服务端口 ${devHost}:${devPort} 已被占用。请先退出旧的开发实例，再重新启动。`)
  process.exit(1)
}

const vite = spawn(npmCommand, ["run", "dev:web"], {
  stdio: "inherit",
  env: process.env
})

function waitForPort(port, host, child) {
  return new Promise((resolve, reject) => {
    let retryTimer = null

    const cleanup = () => {
      if (retryTimer) clearTimeout(retryTimer)
      child.off("exit", handleExit)
      child.off("error", handleError)
    }

    const handleExit = (code) => {
      cleanup()
      reject(new Error(`Vite 在开发端口就绪前退出（退出码 ${code ?? "未知"}）。`))
    }

    const handleError = (error) => {
      cleanup()
      reject(error)
    }

    const tryConnect = () => {
      const socket = net.createConnection({ port, host })
      socket.once("connect", () => {
        socket.end()
        cleanup()
        resolve()
      })
      socket.once("error", () => {
        retryTimer = setTimeout(tryConnect, 120)
      })
    }

    child.once("exit", handleExit)
    child.once("error", handleError)
    tryConnect()
  })
}

try {
  await waitForPort(devPort, devHost, vite)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (vite.exitCode === null && !vite.killed) vite.kill("SIGTERM")
  process.exit(1)
}

const electron = spawn(electronBinary, ["."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://${devHost}:${devPort}` }
})

let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (vite.exitCode === null && !vite.killed) vite.kill("SIGTERM")
  if (electron.exitCode === null && !electron.killed) electron.kill("SIGTERM")
  process.exit(code)
}

electron.on("exit", (code) => shutdown(code ?? 0))
electron.on("error", (error) => {
  console.error("Electron 启动失败：", error)
  shutdown(1)
})
vite.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 0)
})

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

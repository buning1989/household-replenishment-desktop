import { spawn } from "node:child_process"
import net from "node:net"
import process from "node:process"

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const electronBinary = process.platform === "win32"
  ? "node_modules/.bin/electron.cmd"
  : "node_modules/.bin/electron"

const vite = spawn(npmCommand, ["run", "dev:web"], {
  stdio: "inherit",
  env: process.env
})

function waitForPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tryConnect = () => {
      const socket = net.createConnection({ port, host })
      socket.once("connect", () => {
        socket.end()
        resolve()
      })
      socket.once("error", () => setTimeout(tryConnect, 120))
    }
    tryConnect()
  })
}

await waitForPort(5173)

const electron = spawn(electronBinary, ["."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" }
})

function shutdown(code = 0) {
  if (!vite.killed) vite.kill("SIGTERM")
  process.exit(code)
}

electron.on("exit", (code) => shutdown(code ?? 0))
vite.on("exit", (code) => {
  if (code && !electron.killed) electron.kill("SIGTERM")
})

process.on("SIGINT", () => {
  if (!electron.killed) electron.kill("SIGTERM")
  shutdown(0)
})


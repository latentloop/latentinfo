#!/usr/bin/env node

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const waitOnTargets = ["tcp:127.0.0.1:5173", "packages/backend/dist/embedded.js"]
const children = new Map()
const foregroundChildren = new Map()

let shuttingDown = false
let electronStarted = false

function pnpmCommand(args, options = {}) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /pnpm/i.test(npmExecPath)) {
    return {
      command: npmExecPath,
      args,
      options,
    }
  }
  return {
    command: "pnpm",
    args,
    options,
  }
}

function spawnProcess(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    stdio: "inherit",
    ...options,
  })

  children.set(child.pid, { name, child })

  child.on("exit", (code, signal) => {
    children.delete(child.pid)
    if (shuttingDown) return

    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`
    console.log(`[${name}] exited with ${detail}`)
    void shutdown(code ?? 0, `${name} exited`)
  })

  child.on("error", (err) => {
    children.delete(child.pid)
    if (shuttingDown) return
    console.error(`[${name}] failed to start:`, err)
    void shutdown(1, `${name} failed`)
  })

  return child
}

function spawnPnpm(name, args, options = {}) {
  const cmd = pnpmCommand(args, options)
  return spawnProcess(name, cmd.command, cmd.args, cmd.options)
}

function runPnpm(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cmd = pnpmCommand(args, options)
    const child = spawn(cmd.command, cmd.args, {
      cwd: rootDir,
      stdio: "inherit",
      ...cmd.options,
    })
    foregroundChildren.set(child.pid, { name, child })

    child.on("exit", (code, signal) => {
      foregroundChildren.delete(child.pid)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${name} exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}`))
      }
    })
    child.on("error", (err) => {
      foregroundChildren.delete(child.pid)
      reject(err)
    })
  })
}

function killGroup(pid, signal) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch (err) {
    if (err?.code !== "ESRCH") throw err
  }
}

function waitForChildrenToExit(timeoutMs) {
  if (children.size === 0) return Promise.resolve()

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs)
    const check = () => {
      if (children.size === 0) {
        clearTimeout(timeout)
        resolve()
      }
    }

    for (const { child } of children.values()) {
      child.once("exit", check)
    }
    check()
  })
}

async function shutdown(exitCode, reason) {
  if (shuttingDown) return
  shuttingDown = true

  if (reason) console.log(`[dev] Stopping child processes (${reason})...`)

  for (const { child } of children.values()) {
    killGroup(child.pid, "SIGTERM")
  }
  for (const { child } of foregroundChildren.values()) {
    child.kill("SIGTERM")
  }

  await waitForChildrenToExit(3000)

  if (children.size > 0) {
    console.log("[dev] Some child processes did not stop after SIGTERM; sending SIGKILL...")
    for (const { child } of children.values()) {
      killGroup(child.pid, "SIGKILL")
    }
    await waitForChildrenToExit(1000)
  }
  for (const { child } of foregroundChildren.values()) {
    child.kill("SIGKILL")
  }

  process.exit(exitCode)
}

process.on("SIGINT", () => void shutdown(0, "SIGINT"))
process.on("SIGTERM", () => void shutdown(0, "SIGTERM"))
process.on("SIGHUP", () => void shutdown(0, "SIGHUP"))

try {
  console.log("Full GUI: Vite frontend + embedded backend compiler + Electron (latent-info://app)")

  await runPnpm("dev:kill", ["dev:kill"])
  await runPnpm("backend-build", ["--filter", "backend", "build"])

  spawnPnpm("vite", ["--filter", "frontend", "dev"])
  spawnPnpm("backend", ["--filter", "backend", "dev"])

  await runPnpm("wait-on", ["exec", "wait-on", ...waitOnTargets])
  if (!shuttingDown) {
    electronStarted = true
    spawnPnpm("electron", ["--filter", "gui", "dev"], {
      env: {
        ...process.env,
        VITE_DEV_URL: "http://127.0.0.1:5173",
      },
    })
  }
} catch (err) {
  console.error("[dev]", err instanceof Error ? err.message : err)
  await shutdown(1, "startup failed")
}

if (!electronStarted && !shuttingDown) {
  await shutdown(1, "electron did not start")
}

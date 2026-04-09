/**
 * electron-builder afterPack hook.
 * Strips non-English locale files from the Electron Framework to reduce app size.
 */
const { readdirSync, rmSync } = require("fs")
const { join } = require("path")

module.exports = async function afterPack(context) {
  const resourcesDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
  )

  const keep = new Set(["en.lproj"])
  let removed = 0

  for (const entry of readdirSync(resourcesDir)) {
    if (entry.endsWith(".lproj") && !keep.has(entry)) {
      rmSync(join(resourcesDir, entry), { recursive: true })
      removed++
    }
  }

  console.log(`  • stripped ${removed} unused locale directories from Electron Framework`)
}

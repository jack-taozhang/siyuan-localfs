#!/usr/bin/env node
/**
 * 核对远端仓库内容与本地是否**逐字节一致**。
 *
 * ★ 为什么必须逐字节核对 ★
 *   本机 `git push` 不可用，全靠 Git Data API 整树推 —— 而 API 这条路有几个
 *   静默出错的坑（空仓 409、本地 blob 服务端不存在、二进制走 utf8 往返会坏）。
 *   一旦出错，**GitHub 一声不吭**，仓库看起来是正常的，内容却是错的。
 *   所以发版前必须逐文件比对，不能只看"推送成功"。
 *
 * 用法：node tools/gh-verify-remote.mjs [仓库名…]
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const API = "https://api.github.com"

const REPOS = {
  "siyuan-localfs": [resolve(HERE, "..", "siyuan-localfs")],
  "fnos-file-viewer": [resolve(HERE, "..", "fnos-file-viewer")],
  "fnos-dwg-viewer": [resolve(HERE, "..", "fnos-dwg-viewer", "fnos-dwg-viewer")],
  "siyuannote-fnos-app": [resolve(HERE, "..", "siyuannote-fnos-app")],
  "siyuan-diskcanvas": [resolve(HERE, "..", "siyuan-diskcanvas")],
}

function readToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env && env.trim()) return env.trim()
  for (const p of [resolve(HERE, ".gh-token"), resolve(HERE, "..", "siyuan-diskcanvas", ".gh-token")]) {
    if (existsSync(p)) { const v = readFileSync(p, "utf8").trim(); if (v) return v }
  }
  return null
}

function run(cmd, args, opts = {}) {
  return new Promise((r) => {
    let c
    try { c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts }) } catch (e) { r({ code: -1, out: Buffer.alloc(0) }); return }
    const o = []
    c.stdout?.on("data", (d) => o.push(Buffer.from(d)))
    c.on("error", () => r({ code: -1, out: Buffer.concat(o) }))
    c.on("close", (code) => r({ code: code ?? -1, out: Buffer.concat(o) }))
  })
}

const md5 = (b) => createHash("md5").update(b).digest("hex")

async function main() {
  const token = readToken()
  if (!token) { console.log("❌ 没有 token"); process.exit(1) }
  const me = await (await fetch(API + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "verify" } })).json()
  const owner = me.login

  const pick = process.argv.slice(2).filter((a) => REPOS[a])
  const names = pick.length ? pick : Object.keys(REPOS)
  let bad = 0

  for (const name of names) {
    const dir = REPOS[name][0]
    const ls = await run("git", ["ls-tree", "-r", "-z", "HEAD"], { cwd: dir })
    const entries = ls.out.toString("utf8").split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t")
      const meta = line.slice(0, tab).split(/\s+/)
      return { path: line.slice(tab + 1), sha: meta[2] }
    })
    const localMap = new Map(entries.map((e) => [e.path, e.sha]))

    const res = await fetch(`${API}/repos/${owner}/${name}/git/trees/main?recursive=1`, {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "verify" },
    })
    const tj = await res.json()
    if (!tj.tree) { console.log(`❌ ${name}: 取 tree 失败 ${res.status} ${JSON.stringify(tj).slice(0, 120)}`); bad++; continue }
    const remoteMap = new Map(tj.tree.filter((x) => x.type === "blob").map((x) => [x.path, x.sha]))

    const missing = [...localMap.keys()].filter((p) => !remoteMap.has(p))
    const extra = [...remoteMap.keys()].filter((p) => !localMap.has(p))
    const differ = [...localMap.keys()].filter((p) => remoteMap.has(p) && remoteMap.get(p) !== localMap.get(p))

    // 抽查内容：git blob 的 sha1 与 GitHub 的 sha 是同一种算法 ⇒ sha 相同即内容逐字节一致
    const ok = missing.length === 0 && extra.length === 0 && differ.length === 0
    console.log(`${ok ? "✅" : "❌"} ${name}: 本地 ${localMap.size} 个文件 / 远端 ${remoteMap.size} 个`)
    if (missing.length) console.log("   远端缺失: " + missing.slice(0, 8).join(", "))
    if (extra.length) console.log("   远端多余: " + extra.slice(0, 8).join(", "))
    if (differ.length) console.log("   内容不一致: " + differ.slice(0, 8).join(", "))
    if (!ok) bad++
  }
  console.log(bad ? `\n❌ ${bad} 个仓库不一致` : "\n✅ 全部逐字节一致")
  process.exit(bad ? 1 : 0)
}
main()
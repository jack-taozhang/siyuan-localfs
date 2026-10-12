#!/usr/bin/env node
/** 诊断：把 GitHub 上刚建出来的 tree 逐条拉下来，与本地 ls-tree 对比 path/mode/sha */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const API = "https://api.github.com"
const DIRS = {
  "fnos-file-viewer": resolve(HERE, "..", "fnos-file-viewer"),
  "siyuannote-fnos-app": resolve(HERE, "..", "siyuannote-fnos-app"),
}
function tok() {
  const e = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (e?.trim()) return e.trim()
  const p = resolve(HERE, "..", "siyuan-diskcanvas", ".gh-token")
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null
}
function run(c, a, o = {}) {
  return new Promise((r) => {
    let ch; try { ch = spawn(c, a, { stdio: ["ignore", "pipe", "pipe"], ...o }) } catch { r({ code: -1, out: "" }); return }
    let out = ""; ch.stdout.on("data", (d) => out += d)
    ch.on("close", (code) => r({ code, out }))
  })
}
const t = tok()
const me = await (await fetch(API + "/user", { headers: { Authorization: "Bearer " + t } })).json()
const H = { Authorization: "Bearer " + t, "User-Agent": "diag" }

for (const [name, dir] of Object.entries(DIRS)) {
  console.log("\n=== " + name)
  // 本地新建一棵等价 tree，看 git 自己算出的 sha
  const ls = await run("git", ["ls-tree", "-r", "HEAD"], { cwd: dir })
  const local = ls.out.trim().split("\n").map((l) => {
    const m = l.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/)
    return m ? { mode: m[1], type: m[2], sha: m[3], path: m[4] } : null
  }).filter(Boolean)
  console.log("  本地条目 " + local.length)
  const modes = {}
  for (const e of local) modes[e.mode] = (modes[e.mode] || 0) + 1
  console.log("  本地 mode 分布 " + JSON.stringify(modes))

  // 远端当前 tree
  const ref = await (await fetch(`${API}/repos/${me.login}/${name}/git/ref/heads/main`, { headers: H })).json()
  const cm = await (await fetch(`${API}/repos/${me.login}/${name}/git/commits/${ref.object.sha}`, { headers: H })).json()
  console.log("  远端 tree " + cm.tree.sha)
  const rt = await (await fetch(`${API}/repos/${me.login}/${name}/git/trees/${cm.tree.sha}?recursive=1`, { headers: H })).json()
  const rem = new Map((rt.tree || []).filter((x) => x.type === "blob").map((x) => [x.path, x]))
  let shown = 0
  for (const e of local) {
    const r = rem.get(e.path)
    if (!r) { if (shown++ < 5) console.log(`  ✗ 缺失 ${e.path}`); continue }
    if (r.sha !== e.sha) { if (shown++ < 5) console.log(`  ✗ sha 不同 ${e.path}  本地${e.sha.slice(0,8)} 远端${r.sha.slice(0,8)}`) }
    else if (r.mode !== e.mode) { if (shown++ < 5) console.log(`  ✗ mode 不同 ${e.path}  本地${e.mode} 远端${r.mode}`) }
  }
  // 本地建 tree 的 sha 作为基准
  const idx = await run("git", ["ls-files", "--stage"], { cwd: dir })
  console.log("  本地 git ls-files --stage 行数 " + idx.out.trim().split("\n").filter(Boolean).length)
}
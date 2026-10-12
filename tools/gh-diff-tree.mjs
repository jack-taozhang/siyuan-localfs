#!/usr/bin/env node
/** 直接比对每个仓的 ref → commit → tree sha（绕开 recursive 树查询） */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const API = "https://api.github.com"
const REPOS = {
  "siyuan-localfs": resolve(HERE, "..", "siyuan-localfs"),
  "fnos-file-viewer": resolve(HERE, "..", "fnos-file-viewer"),
  "fnos-dwg-viewer": resolve(HERE, "..", "fnos-dwg-viewer", "fnos-dwg-viewer"),
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
    let out = "", err = ""
    ch.stdout.on("data", (d) => out += d); ch.stderr.on("data", (d) => err += d)
    ch.on("close", (code) => r({ code, out, err }))
  })
}
const t = tok()
const me = await (await fetch(API + "/user", { headers: { Authorization: "Bearer " + t } })).json()
for (const [name, dir] of Object.entries(REPOS)) {
  const localTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir })).out.trim()
  const ref = await (await fetch(`${API}/repos/${me.login}/${name}/git/ref/heads/main`, { headers: { Authorization: "Bearer " + t } })).json()
  let remoteTree = "?"
  if (ref?.object?.sha) {
    const c = await (await fetch(`${API}/repos/${me.login}/${name}/git/commits/${ref.object.sha}`, { headers: { Authorization: "Bearer " + t } })).json()
    remoteTree = c?.tree?.sha || "?"
  }
  console.log(`${localTree === remoteTree ? "✅" : "❌"} ${name}\n   local  tree ${localTree}\n   remote tree ${remoteTree}`)
}
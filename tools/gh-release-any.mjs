#!/usr/bin/env node
/**
 * 给任意仓库发布 GitHub Release 并挂上构建产物。
 *
 * 与 diskcanvas 的 tools/gh-release.mjs 同源思路，但**不依赖那个仓库**
 * —— 那四个仓（localfs / file-viewer / dwg-viewer / siyuannote-fnos-app）
 * 本来就没有这个脚本，而发版是从**本机**驱动、往**远端**挂东西，
 * 工具放在哪儿都能用。
 *
 * 用法：
 *   node tools/gh-release-any.mjs --repo siyuan-localfs --tag v1.12.11 \
 *        --asset D:/Docker/siyuan-localfs/dist-package/siyuan-localfs-1.12.11.zip \
 *        --title "本机存储 v1.12.11" --notes-file notes.md
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const API = "https://api.github.com"

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : undefined }
const has = (n) => process.argv.includes("--" + n)

function readToken() {
  const e = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (e?.trim()) return e.trim()
  for (const p of [resolve(HERE, ".gh-token"), resolve(HERE, "..", "siyuan-diskcanvas", ".gh-token")]) {
    if (existsSync(p)) { const v = readFileSync(p, "utf8").trim(); if (v) return v }
  }
  return null
}
function run(c, a, o = {}) {
  return new Promise((r) => {
    let ch
    try { ch = spawn(c, a, { stdio: ["ignore", "pipe", "pipe"], ...o }) } catch (e) { r({ code: -1, out: "", err: String(e) }); return }
    let out = "", err = ""
    ch.stdout?.on("data", (d) => out += d); ch.stderr?.on("data", (d) => { err += d })
    ch.on("close", (code) => r({ code: code ?? -1, out, err }))
  })
}
async function api(token, method, path, body, raw) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "siyuan-release",
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
    },
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  const text = buf.toString("utf8")
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 二进制或非 JSON */ }
  return { status: res.status, json, text, buf }
}

const repo = arg("repo"); const tag = arg("tag"); const asset = arg("asset")
const title = arg("title"); let notes = arg("notes") || ""
const notesFile = arg("notes-file")
if (notesFile && existsSync(notesFile)) notes = readFileSync(notesFile, "utf8")
if (!repo || !tag) { console.log("❌ 需要 --repo 与 --tag"); process.exit(1) }

const token = readToken()
if (!token) { console.log("❌ 没有 token"); process.exit(1) }
const me = await api(token, "GET", "/user")
if (me.status !== 200) { console.log("❌ token 无效"); process.exit(1) }
const owner = me.json.login

// 1) tag（不存在才建）
const ref = await api(token, "GET", `/repos/${owner}/${repo}/git/ref/tags/${tag}`)
if (ref.status === 404) {
  const head = await api(token, "GET", `/repos/${owner}/${repo}/git/ref/heads/main`)
  const mk = await api(token, "POST", `/repos/${owner}/${repo}/git/refs`, {
    ref: "refs/tags/" + tag, sha: head.json.object.sha,
  })
  console.log(mk.status === 201 ? "✅ 已建 tag " + tag : "❌ 建 tag 失败 " + mk.text.slice(0, 150))
  if (mk.status !== 201) process.exit(1)
} else console.log("· tag 已存在")

// 2) release（不存在才建）
const rel = await api(token, "GET", `/repos/${owner}/${repo}/releases/tags/${tag}`)
let relId
if (rel.status === 404) {
  const cr = await api(token, "POST", `/repos/${owner}/${repo}/releases`, {
    tag_name: tag, name: title || tag, body: notes, draft: false, prerelease: false,
  })
  if (cr.status !== 201) { console.log("❌ 建 release 失败 " + cr.status + ": " + cr.text.slice(0, 200)); process.exit(1) }
  relId = cr.json.id
  console.log("✅ 已建 release id=" + relId)
} else { relId = rel.json.id; console.log("· release 已存在 id=" + relId) }

// 3) 挂附件
if (asset) {
  if (!existsSync(asset)) { console.log("❌ 附件不存在: " + asset); process.exit(1) }
  const name = basename(asset)
  const data = readFileSync(asset)
  // GitHub 上传附件要单独走 uploads 域，且用 binary content-type
  const up = await fetch(`https://uploads.github.com/repos/${owner}/${repo}/releases/${relId}/assets?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "User-Agent": "siyuan-release",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: data,
  })
  const upText = await up.text()
  if (up.status !== 201) { console.log("❌ 上传附件失败 " + up.status + ": " + upText.slice(0, 200)); process.exit(1) }
  const uj = JSON.parse(upText)
  console.log(`✅ 附件 ${uj.name} ${data.length} bytes`)
} else console.log("· 未指定 --asset，跳过附件")

// 4) 回读核对
const chk = await api(token, "GET", `/repos/${owner}/${repo}/releases/tags/${tag}`)
if (chk.status !== 200) { console.log("❌ 回读 release 失败"); process.exit(1) }
const j = chk.json
console.log("Release: " + j.html_url)
for (const a of j.assets) console.log(`   ${a.name}  ${a.size} bytes`)
if (asset) {
  const want = basename(asset), size = readFileSync(asset).length
  const got = j.assets.find((a) => a.name === want)
  console.log(got && got.size === size ? "   附件大小匹配: ✓" : "   ★ 附件不匹配")
}
console.log("\nRELEASE_OK " + j.html_url)
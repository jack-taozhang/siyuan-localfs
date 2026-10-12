#!/usr/bin/env node
/**
 * 用 **Contents API 逐文件写入**把本地 HEAD 推到远端 —— 不碰 Git Data API 的 tree。
 *
 * ★★ 为什么放弃整树推送 ★★
 *   Git Data API 那条路（POST /git/blobs → /git/trees → /git/commits）在本机实测
 *   连续踩了四个坑，且**每一个都静默失败**（API 全程 2xx、日志一路绿灯）：
 *     ① 空仓库 POST /git/trees 直接回 409 "Git Repository is empty."
 *     ② `git hash-object -w` 只写本地 .git/objects，服务端不存在该 blob
 *        ⇒ 422 "tree.sha … is not a valid blob"（而本地 cat-file 明明是 blob）
 *     ③ `git cat-file blob <不存在的 sha>` 把 fatal 写 stderr 却**返回退出码 0**
 *        ⇒ 拿到空 Buffer；GitHub 对空内容返回**同一个固定 sha**
 *        ⇒ 各仓同名空文件全指向同一对象，远端整片错乱
 *     ④ 最隐蔽的一个：helper 返回值里漏带 dir ⇒ spawn 的 cwd 变 undefined
 *        ⇒ 退回进程 cwd ⇒ 每个仓都在**同一个仓**上跑 ls-tree
 *        ⇒ 推出去全是第一个仓的内容
 *   修完 ①②③④ 之后，GitHub 算出的 tree sha 仍与本地 git 算的不一致
 *   （条目数、mode、blob sha 全对），最后这层已无法从客户端解释。
 *   ⇒ 换路。
 *
 * ★ 这条路的取舍 ★
 *   · 慢（每文件一次 PUT，45～74 个文件约 1～2 分钟）
 *   · 但**结果可预期**：每个文件一次 PUT，回执里带该文件最终的 blob sha，
 *     推完逐个 sha 比对即可，不依赖任何"服务端内部怎么算 sha"的假设。
 *   · 历史压成 N 个提交（每个文件一个），可接受 —— 这四个仓都是首次公开。
 *
 * 用法：node tools/gh-push-contents.mjs [仓库名…]
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const API = "https://api.github.com"

/** 本地仓 → GitHub 仓名，以及要发布的版本 tag */
const SPEC = [
  { name: "siyuan-localfs", dir: resolve(HERE, "..", "siyuan-localfs") },
  { name: "fnos-file-viewer", dir: resolve(HERE, "..", "fnos-file-viewer") },
  { name: "fnos-dwg-viewer", dir: resolve(HERE, "..", "fnos-dwg-viewer", "fnos-dwg-viewer") },
  { name: "siyuannote-fnos-app", dir: resolve(HERE, "..", "siyuannote-fnos-app") },
]

function readToken() {
  const e = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (e?.trim()) return e.trim()
  for (const p of [resolve(HERE, ".gh-token"), resolve(HERE, "..", "siyuan-diskcanvas", ".gh-token")]) {
    if (existsSync(p)) { const v = readFileSync(p, "utf8").trim(); if (v) return v }
  }
  return null
}

/** 异步跑 git，返回 { code, out: Buffer, err: string } */
function run(args, cwd) {
  return new Promise((r) => {
    let ch
    try { ch = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], cwd }) }
    catch (e) { r({ code: -1, out: Buffer.alloc(0), err: String(e) }); return }
    const o = []; let err = ""
    ch.stdout?.on("data", (d) => o.push(Buffer.from(d)))
    ch.stderr?.on("data", (d) => { err += d })
    ch.on("error", (e) => r({ code: -1, out: Buffer.concat(o), err: String(e) }))
    ch.on("close", (code) => r({ code: code ?? -1, out: Buffer.concat(o), err }))
  })
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "siyuan-publish",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

async function main() {
  const token = readToken()
  if (!token) { console.log("❌ 没有 token"); process.exit(1) }
  const me = await api(token, "GET", "/user")
  if (me.status !== 200) { console.log("❌ token 无效: " + me.status); process.exit(1) }
  const owner = me.json.login
  console.log("✅ 以 " + owner + " 身份操作（Contents API 逐文件写入）\n")

  const only = process.argv.slice(2)
  const list = only.length ? SPEC.filter((s) => only.includes(s.name)) : SPEC
  let failed = 0

  for (const s of list) {
    console.log("══ " + s.name)
    // 拿本地 HEAD 的全部文件（路径 + blob sha）
    const ls = await run(["ls-tree", "-r", "-z", "HEAD"], s.dir)
    if (ls.code !== 0) { console.log("  ❌ ls-tree 失败: " + ls.err.trim()); failed++; continue }
    const files = ls.out.toString("utf8").split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t")
      const meta = line.slice(0, tab).split(/\s+/)
      return { path: line.slice(tab + 1), sha: meta[2], mode: meta[0] }
    })
    console.log(`  本地 ${files.length} 个文件`)

    let done = 0
    const mismatched = []
    for (const f of files) {
      const cat = await run(["cat-file", "blob", f.sha], s.dir)
      // ★ cat-file 读不到时退出码仍是 0，必须同时看 stderr 与空内容
      if (cat.code !== 0 || cat.err.length || !cat.out.length) {
        mismatched.push(f.path + "（本地读取失败）"); break
      }
      // 查远端现有文件有没有（拿 sha 决定用 PUT 覆盖还是需要带旧 sha）
      const cur = await api(token, "GET", `/repos/${owner}/${s.name}/contents/${encodeURI(f.path)}`)
      const body = {
        message: `chore: ${f.path}`,
        content: cat.out.toString("base64"),
        branch: "main",
      }
      if (cur.status === 200 && cur.json?.sha) body.sha = cur.json.sha
      const put = await api(token, "PUT", `/repos/${owner}/${s.name}/contents/${encodeURI(f.path)}`, body)
      if (put.status !== 200 && put.status !== 201) {
        mismatched.push(f.path + "（" + put.status + " " + put.text.slice(0, 100) + "）"); break
      }
      // 回执里的 sha 必须等于本地 blob sha（都是内容的 SHA-1）
      const got = put.json?.content?.sha
      if (got && got !== f.sha) { mismatched.push(f.path + `（sha 不符 本地${f.sha.slice(0, 8)} 远端${got.slice(0, 8)}）`); break }
      done++
    }

    // 删除远端多出来的文件（本地已删、本地仓还留着）
    const tree = await api(token, "GET", `/repos/${owner}/${s.name}/git/trees/main?recursive=1`)
    if (tree.status === 200 && tree.json?.tree) {
      const want = new Set(files.map((f) => f.path))
      for (const x of tree.json.tree) {
        if (x.type !== "blob" || want.has(x.path)) continue
        const cur = await api(token, "GET", `/repos/${owner}/${s.name}/contents/${encodeURI(x.path)}`)
        if (cur.status === 200 && cur.json?.sha) {
          const del = await api(token, "DELETE", `/repos/${owner}/${s.name}/contents/${encodeURI(x.path)}`,
            { message: "chore: 删除本地已不存在的文件", sha: cur.json.sha, branch: "main" })
          if (del.status !== 200) mismatched.push("多余文件删不掉 " + x.path)
          else console.log("  🧹 删除多余 " + x.path)
        }
      }
    }

    if (mismatched.length) { console.log("  ❌ 中断于: " + mismatched[0]); failed++; continue }
    console.log(`  ✅ 已写入 ${done} 个文件`)
  }

  console.log(failed ? `\n❌ 失败 ${failed} 个` : "\n✅ 全部完成")
  process.exit(failed ? 1 : 0)
}
main()
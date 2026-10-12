#!/usr/bin/env node
/**
 * 在 GitHub 上**批量建仓并推送**本地 HEAD —— 走 api.github.com，不走 git 传输。
 *
 * ★ 为什么不用 `gh` / `git push` ★
 *   · 本机**没装 gh**；
 *   · `git push` 在本机会失败，两条路都堵：
 *     凭据侧 GCM（git-credential-manager）在非桌面 shell 会卡死（实测 exit 124），
 *     传输侧 github.com 的 HTTPS 时通时断（schannel 报错）。
 *   而 **api.github.com 一直稳** ⇒ 绕开 git 的传输与凭据链路，直接走 REST。
 *   （这套做法来自 siyuan-diskcanvas/tools/gh-push-api.mjs，本脚本是它的批量版。）
 *
 * ★★ 不调用同步族子进程 ★★
 *   `execSync` / `execFileSync` / `spawnSync` 在本机沙箱**一律 EBUSY**，
 *   而 `spawnSync` 最阴 —— 它不抛异常，只静默返回 `{status:null,error:'EBUSY'}`。
 *   ⇒ 全部走异步 `spawn`。
 *
 * 用法：
 *   node tools/gh-publish-all.mjs                # 推送 SPEC 里的全部仓库
 *   node tools/gh-publish-all.mjs --dry-run      # 只打印要做什么
 *   node tools/gh-publish-all.mjs --only siyuan-localfs
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const API = "https://api.github.com"

/** 要建仓并推送的仓库清单（本地目录已 git init 且已提交） */
const SPEC = [
  {
    dir: resolve(HERE, "..", "siyuan-localfs"),
    name: "siyuan-localfs",
    desc: "思源笔记插件：在思源侧边栏里直接浏览与预览 NAS 本机存储空间（飞牛 fnOS）",
    tag: "v1.12.11",
  },
  {
    dir: resolve(HERE, "..", "fnos-file-viewer"),
    name: "fnos-file-viewer",
    desc: "飞牛 fnOS 原生「文件预览」应用 —— 274 种扩展名，纯浏览器端解析渲染，文件不出内网",
    tag: "v1.0.3",
  },
  {
    dir: resolve(HERE, "..", "fnos-dwg-viewer", "fnos-dwg-viewer"),
    name: "fnos-dwg-viewer",
    desc: "飞牛 fnOS 原生「CAD 看图」应用 —— DWG/DXF 在线预览，基于 @mlightcad/cad-viewer",
    tag: "v1.0.9",
  },
  {
    dir: resolve(HERE, "..", "siyuannote-fnos-app"),
    name: "siyuannote-fnos-app",
    desc: "思源笔记的飞牛 fnOS 原生应用 —— 原生运行思源内核 3.8.6，不依赖 Docker",
    tag: "v2.2.1",
  },
]

function say(...a) { console.log(...a) }

/** 异步跑一条命令 ⇒ {code, out, err}（out 是 Buffer —— 仓库里有 PNG/WASM，
 *  按字符串拼接会把二进制截断 ⇒ 必须保留 Buffer 再自行 toString） */
function run(cmd, args, opts = {}) {
  return new Promise((resolve_) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts })
    } catch (e) {
      resolve_({ code: -1, out: Buffer.alloc(0), err: String(e) })
      return
    }
    const out = []
    let err = ""
    child.stdout?.on("data", (d) => out.push(Buffer.from(d)))
    child.stderr?.on("data", (d) => { err += d })
    child.on("error", (e) => resolve_({ code: -1, out: Buffer.concat(out), err: String(e) }))
    child.on("close", (code) => resolve_({ code: code == null ? -1 : code, out: Buffer.concat(out), err }))
  })
}
/** run() 的文本快捷方式 */
const runText = async (cmd, args, opts) => (await run(cmd, args, opts)).out.toString("utf8")

/** 读 token：环境变量优先，其次 .gh-token（已 gitignore） */
function readToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env && env.trim()) return env.trim()
  for (const p of [resolve(HERE, ".gh-token"), resolve(HERE, "..", ".gh-token"),
                   resolve(HERE, "..", "siyuan-diskcanvas", ".gh-token")]) {
    if (existsSync(p)) {
      const v = readFileSync(p, "utf8").trim()
      if (v) return v
    }
  }
  return null
}

/** 直接调 REST（fetch 在本机是 async，不属于同步族） */
async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "siyuan-publish-script",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

/** 本地 HEAD 的 tree sha —— 建仓后用它对齐远端基点。
 *  ★ dir 必须一起带出去 ★
 *    这个函数最早只返回 { sha, tree }，而调用方 pushTree 里用的是
 *    `info.dir` 做 `spawn` 的 cwd ⇒ 实为 `undefined` ⇒ spawn 退回进程 cwd
 *    （脚本所在仓 siyuan-localfs）⇒ 后面 ls-tree / cat-file / log 全都
 *    **在同一个仓上跑**。于是每个仓推上去的都是第一个仓的内容，
 *    而 API 一路 201/200、日志全绿 —— 只有逐字节核对才看得出来。 */
async function headInfo(dir) {
  const r = await run("git", ["rev-parse", "HEAD"], { cwd: dir })
  const sha = r.out.toString("utf8").trim()
  if (r.code !== 0 || !sha) return null
  const t = await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir })
  return { dir, sha, tree: t.out.toString("utf8").trim() }
}

/** 用 Git Data API 把本地 HEAD 的整棵树推上去（远端历史压成一个提交） */
async function pushTree(token, owner, repo, info, branch = "main") {
  // 1) 取远端当前 ref（可能不存在）
  const ref = await api(token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  let baseTree = null
  let hasCommit = false
  if (ref.status === 200 && ref.json?.object?.type === "commit") {
    const c = await api(token, "GET", `/repos/${owner}/${repo}/git/commits/${ref.json.object.sha}`)
    if (c.status === 200) { baseTree = c.json.tree?.sha; hasCommit = true }
  }

  // 1.5) ★ 空仓库必须先有初始提交 ★
  //   POST /git/trees 对**完全空**的仓库一律回 409 "Git Repository is empty."
  //   （它没有 base_tree 可挂）。而 Contents API 允许往空仓写文件，
  //   所以先用它落一个 README，把仓"点亮"，再回到 tree API 整树推。
  if (!baseTree) {
    const rd = await run("git", ["show", "HEAD:README.md"], { cwd: info.dir })
    const body = rd.code === 0 ? rd.out.toString("utf8") : "# " + repo + "\n"
    const put = await api(token, "PUT", `/repos/${owner}/${repo}/contents/README.md`, {
      message: "chore: 初始化仓库", content: Buffer.from(body, "utf8").toString("base64"),
    })
    if (put.status !== 200 && put.status !== 201) {
      throw new Error("点亮空仓失败 " + put.status + ": " + put.text.slice(0, 300))
    }
    const r2 = await api(token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    const c2 = await api(token, "GET", `/repos/${owner}/${repo}/git/commits/${r2.json.object.sha}`)
    baseTree = c2.json.tree?.sha
    hasCommit = true
  }

  // 2) 登记 blob —— ★ 必须走 API，不能只用本地 `git hash-object -w` ★
//   ★★ 这里踩过一个很隐蔽的坑 ★★
//   `git hash-object -w -- path` 只把 blob 写进**本地** .git/objects；
//   GitHub 服务端**并不存在**这个对象。于是 POST /git/trees 会回
//   422 "tree.sha <sha> is not a valid blob" —— 那个 sha 在本地 `git cat-file -t`
//   明明就是 blob，排查时极具迷惑性。
//   ⇒ 每个文件都要先用 POST /git/blobs 在服务端建一次（内容 base64 传输）。
const uploaded = new Map()   // 本地 sha → 远端 sha（同内容只传一次）
async function uploadBlob(absPath, localSha) {
  if (uploaded.has(localSha)) return uploaded.get(localSha)
  const cat = await run("git", ["cat-file", "blob", localSha], { cwd: absPath })
  // ★★ 必须同时判 stderr ★★
  //   `git cat-file blob <不存在的 sha>` 会把 `fatal: … bad file` 写到 **stderr**，
  //   而**退出码仍是 0**（实测）。只看退出码就会拿到**空 Buffer**，
  //   再传上去就成了"内容为空的 blob"。
  //   而 GitHub 对空内容**返回同一个固定 sha** ⇒ 所有仓库里同名的空文件
  //   全指向同一个对象 ⇒ 远端看起来"推送成功"，内容却整片错乱。
  //   这个坑的表现极有迷惑性：API 全部 201/200，日志一路绿灯。
  if (cat.code !== 0 || cat.err.length) {
    throw new Error("cat-file 读不到 " + localSha + "（cwd=" + absPath + "）：" + cat.err.trim())
  }
  if (!cat.out.length) {
    throw new Error("cat-file 返回空内容 " + localSha + "（cwd=" + absPath + "）")
  }
  const r = await api(token, "POST", `/repos/${owner}/${repo}/git/blobs`, {
    // ★ 直接用 Buffer 转 base64：blob 可能是 PNG/WASM，
    //   走 utf8 字符串往返会损坏二进制。
    content: cat.out.toString("base64"),
    encoding: "base64",
  })
  if (r.status !== 201) throw new Error("建 blob 失败 " + r.status + ": " + r.text.slice(0, 200))
  // 服务端算出的 sha 必须与我们本地的 sha 一致（都是内容的 SHA-1），
  // 不一致说明传上去的东西被改写了 —— 立刻停，别把错的推出去。
  if (r.json.sha !== localSha) {
    throw new Error("blob sha 不一致：本地 " + localSha + " / 远端 " + r.json.sha
      + "（二进制在传输中被损坏）")
  }
  uploaded.set(localSha, r.json.sha)
  return r.json.sha
}

  const ls = await run("git", ["ls-tree", "-r", "-z", "HEAD"], { cwd: info.dir })
  if (ls.code !== 0) throw new Error("ls-tree 失败: " + ls.err)
  const entries = ls.out.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t")
    const meta = line.slice(0, tab).split(/\s+/)
    return { path: line.slice(tab + 1), mode: meta[0], type: meta[1], sha: meta[2] }
  })
  const treeItems = []
  for (const e of entries) {
    // ★ mode 必须原样传本地值，不能一律 100644 ★
    //   仓库里有可执行文件（*.sh / cmd/* 生命周期脚本），本地是 100755。
    //   抹成 100644 会让整棵 tree 的 sha 与本地不一致（内容对、mode 错），
    //   而且推送照样"成功" —— 只有比 tree sha 才看得出来。
    treeItems.push({ path: e.path, mode: e.mode, type: e.type, sha: await uploadBlob(info.dir, e.sha) })
  }

  const treeRes = await api(token, "POST", `/repos/${owner}/${repo}/git/trees`, {
    tree: treeItems,
    ...(baseTree ? { base_tree: baseTree } : {}),
  })
  // ★ 自检：建出来的 tree 必须与本地 HEAD 的 tree 一致。
  //   不一致说明 treeItems 用错了仓库的内容（曾因跨仓复用而整片推错，
  //   而 API 全程 201/200、一路绿灯）。宁可停下，也别把错内容推上去。
  if (treeRes.status === 201 && info.tree && treeRes.json.sha !== info.tree) {
    throw new Error(`tree 不一致：本地 ${info.tree} / 远端 ${treeRes.json.sha}`
      + `（repo=${repo}，条目 ${treeItems.length} 个）—— 拒绝推送`)
  }
  if (treeRes.status !== 201) throw new Error("建 tree 失败 " + treeRes.status + ": " + treeRes.text.slice(0, 300))

  const parents = hasCommit
    ? [(await api(token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`)).json.object.sha]
    : []
  const msg = (await run("git", ["log", "-1", "--pretty=%B"], { cwd: info.dir })).out.toString("utf8").trim()
  const commit = await api(token, "POST", `/repos/${owner}/${repo}/git/commits`, {
    message: msg || "init", tree: treeRes.json.sha, parents,
  })
  if (commit.status !== 201) throw new Error("建 commit 失败 " + commit.status + ": " + commit.text.slice(0, 300))

  const upd = await api(token, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    sha: commit.json.sha, force: true,
  })
  if (upd.status !== 200 && upd.status !== 201) {
    throw new Error("更新 ref 失败 " + upd.status + ": " + upd.text.slice(0, 300))
  }
  return commit.json.sha
}

async function main() {
  const dry = process.argv.includes("--dry-run")
  const onlyIdx = process.argv.indexOf("--only")
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null

  const token = readToken()
  if (!token) { say("❌ 找不到 GitHub token（环境变量 GITHUB_TOKEN 或 .gh-token）"); process.exit(1) }

  const me = await api(token, "GET", "/user")
  if (me.status !== 200) { say("❌ token 无效或网络不通: " + me.status + " " + me.text.slice(0, 200)); process.exit(1) }
  const owner = me.json.login
  say("✅ 以 " + owner + " 身份操作")

  const list = only ? SPEC.filter((s) => s.name === only) : SPEC
  if (!list.length) { say("❌ --only 没匹配到: " + only); process.exit(1) }

  let failed = 0
  for (const s of list) {
    say("\n══ " + s.name)
    const info = await headInfo(s.dir)
    if (!info) { say("  ❌ 本地没有提交，跳过"); failed++; continue }
    say("  本地 HEAD " + info.sha.slice(0, 10))

    if (dry) { say("  [dry-run] 跳过建仓与推送"); continue }

    // 1) 建仓（已存在就跳过）
    const probe = await api(token, "GET", `/repos/${owner}/${s.name}`)
    if (probe.status === 404) {
      const cr = await api(token, "POST", "/user/repos", {
        name: s.name, description: s.desc, private: false,
        auto_init: false, has_issues: true, has_wiki: false,
      })
      if (cr.status !== 201) { say("  ❌ 建仓失败 " + cr.status + ": " + cr.text.slice(0, 300)); failed++; continue }
      say("  ✅ 已建公开仓 " + owner + "/" + s.name)
    } else if (probe.status === 200) {
      say("  · 仓库已存在，沿用")
    } else {
      say("  ❌ 查询仓库失败 " + probe.status + ": " + probe.text.slice(0, 200)); failed++; continue
    }

    // 2) 推送
    try {
      const sha = await pushTree(token, owner, s.name, info)
      say("  ✅ 推送完成，远端 HEAD " + sha.slice(0, 10))
      // 3) 落地远端引用，省得下次再猜
      await run("git", ["remote", "remove", "origin"], { cwd: s.dir })
      await run("git", ["remote", "add", "origin", `https://github.com/${owner}/${s.name}.git`], { cwd: s.dir })
      await run("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: s.dir })
      say("  · 已登记 origin/main")
    } catch (e) {
      say("  ❌ 推送失败: " + e.message); failed++
    }
  }

  say("\n" + (failed ? "❌ 失败 " + failed + " 个" : "✅ 全部完成"))
  process.exit(failed ? 1 : 0)
}

main()
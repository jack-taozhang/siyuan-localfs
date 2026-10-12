# 升级指南

思源插件三条线：**版本号对齐**、**本地部署**、**与 NAS 侧应用的联动**。

---

## 1. ★ 版本号必须两处对齐

思源内核**按 `plugin.json` 的 `version` 缓存插件 JS**，版本号不变 ⇒ 用户跑的还是旧代码。

| 文件 | 字段 | 当前 |
|---|---|---|
| `plugin.json` | `version` | 1.12.13（**权威**） |
| `package.json` | `version` | 1.12.13 |

**任何影响 `index.js` / `index.css` 的改动都必须升 `plugin.json` 的 version**，
否则用户那边什么都不会变 —— 且不报任何错。

★ `index.js` 与 `index.css` **必须成对传**：Vue 的 scope id 随源码变，
只更新 JS 会导致样式整体失效。

### 1.1 ★★ 升了版本还不够：前端必须重新加载

`index.js` 是**前端启动时**加载的。文件换掉、版本号也升了，**已经打开的前端
不会自动换**——它跑的还是内存里那份旧 JS，且**不报任何错**。

```bash
# 桌面端：本机内核没有访问授权码时可直接调
curl -s -X POST http://127.0.0.1:6806/api/ui/reloadUI -d '{}'
# NAS 端：内核在 16806（走反代 6806 的 /api/* 会被"文件预览"截走），且要带 API token
#   token 在 data/conf/conf.json 的 "token" 字段（注意：不是 accessAuthCode）
curl -s -X POST http://127.0.0.1:16806/api/ui/reloadUI \
     -H "Authorization: Token <token>" -d '{}'
```

等价于在思源窗口里按 F5。**改完插件必须对每一端都做一次**，否则会出现
"同一份代码、两端口径不一样"的假象。

### 1.2 ★★ 为什么"NAS 有工具栏 / Windows 没有"这类差异会冒出来

净化（`purify.js`）靠往 iframe 注入 CSS，**要求同源**：

| 场景 | iframe 与宿主页 | 注入 | 靠什么藏 CAD 外壳 |
|---|---|---|---|
| NAS 网页版 | 同源 | ✅ 生效 | 注入 **或** `bare=1`（双保险） |
| 桌面客户端 | **必然跨源**（内核在本机、iframe 在 NAS） | ❌ 被浏览器静默丢弃 | **只有 `bare=1`** |

⇒ 若某一端跑的是**旧插件**（没有 `bare=1`），就会出现：
**NAS 上外壳被注入藏掉、Windows 上外壳全露** —— 而代码明明是同一份。
看到这种"两端不一致"，先怀疑**前端没重载**，而不是去改代码。

### 1.3 ★★ `FileView` 的 `bare` 是**三态**，严禁用 `!!` 归一化

```js
this.bare = !!(o && o.bare);        // ❌ 把页签的 "fv" 压成 true
this.bare = bare === undefined || bare === null ? false : bare;   // ✅ 保留三态
```

| 取值 | 含义 | 谁在用 |
|---|---|---|
| `true` | 全净化：file-viewer 藏外壳、**CAD 藏工具栏**、Office 走 `bare=1` | 嵌入块（`embed.js`） |
| `"fv"` | **只**净化 file-viewer；CAD / Office 保留完整界面 | 页签（`tabview.js`，需求 3.1） |
| 省略 | 不净化（浮层保持完整外壳） | 浮层（`preview.js`） |

★★ **这个坑静默了 3 天（2026-10-09 → 10-12）**：`!!"fv" === true`，
于是页签被当成"全净化"，CAD 也去注入 `cad-bare`。后果**两端相反**：

- 同源（NAS 网页版）⇒ 注入成功 ⇒ **页签里 CAD 工具条被藏**
- 跨源（桌面客户端）⇒ 注入被静默丢弃 ⇒ **工具条又冒出来**

也就是"同一份代码、两端口径不同"，而且哪端"看着对"纯属巧合。
`tools/build.js` 的 `selfCheck` 现在会在每次构建时断言三态没被破坏
（注意：断言查的是**抹掉注释后**的文本，因为说明里就写着那段错误写法）。

> ★ 教训：`!!` 会把"有意义的字符串"和 `true` 抹平。凡是**多态参数**
>   （字符串枚举 / 布尔混合），一律显式判 `undefined`，不要图省事写 `!!`。



---

## 2. 构建

```bash
npm run build        # src/ → index.js + index.css（仓库根）
npm run pack         # 出可导入的 zip（从已构建产物取，不重建）
npm test             # 契约测试
```

`package.json` 的 version 必须与 `plugin.json` 对齐。

---

## 3. 本地部署（到 NAS 上跑着的思源）

```bash
# ★ 口令一律从环境变量读，不带默认值 ★
export NAS_PW='你的口令'

bash tools/deploy-nas.sh          # 构建 → scp →/tmp→ sudo cp → md5 双向核对
bash tools/hot-patch-localfs.sh   # 只热补后端 local-fs.py，只重启文件服务进程
```

### 部署纪律（都是踩过的坑）

- **scp → `/tmp` → `cp` → md5 双向核对**。SMB 不可靠，曾出现 scp 全 FAIL 但 cp 照跑。
- **之后必查 `ctime`**：md5 对 ≠ 没人再动过。**判据只认 md5 + ctime。**
- Git Bash 会改写 argv 里的绝对路径（`/tmp/x.sh` → `E:/TEMP/x.sh`）⇒
  传路径前加 `MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1`。
  ⚠️ 跑 `deploy-nas.sh` / `build-fpk-nas.sh` **不能**加这两个变量。
- 容器内**没有 `python3`**（宿主 3.11.2）。paramiko 只在
  `…/envs/default/Scripts/python.exe`。
- 本机 `spawnSync` / `execSync` **一律 EBUSY**（`{status:null,error:'EBUSY'}` 且不抛）
  ⇒ Node 脚本里只用**异步 `spawn`**。

### 插件与 FPK 解耦

FPK 里**不含插件**，只装后端（内核 + `local-fs.py` + `reverse-proxy.py` + `ui`）。

- 改**插件** → 不用重打 FPK，`tools/deploy-nas.sh` 即可。
- 改**后端**（NAS 上的 `.py`）→ 必须重打 FPK，走
  `siyuannote-fnos-app` 的打包流程。

---

## 4. 与 NAS 侧应用的联动

插件预览四条链路，实际有三条是「借用飞牛应用」，全走思源反代 6806 的**同源通道**：

| 格式 | 通道前缀 | 目标应用 | 端口 |
|---|---|---|---|
| DWG / DXF | `/localfs/cad/*` | CAD 看图（fnos-dwg-viewer） | 8020 |
| Office / PDF | `/localfs/docs/*` | 官方「Office文档」 | 5666 |
| 其余全部 | `/localfs/fv/*` | 文件预览（fnos-file-viewer） | 8030 |

### ★ 同源不是"洁癖"，是功能前提

内嵌要**净化**：藏掉查看器自带的工具条 / 命令行 / 底部状态栏 / 左侧文件树 /
Office 工具栏，靠的是 `iframe.contentDocument` 注入样式（`src/purify.js`）。
**一旦跨源，`contentDocument` 恒 null ⇒ 注入静默失败，那些外壳全部回来。**

所以插件侧三条链路**一律走 `:6806`，绝不直连应用端口**（`api.js` 的 `channelUrl`）。

### ⚠️ 桌面客户端是跨源的（已知限制）

思源**桌面客户端**跑的是**本机内核**（`http://127.0.0.1:6806`），本机没有反代；
而 iframe 指向 NAS 的 `http://<nas>:6806` ⇒ **不同源** ⇒ 净化失效。

表现：桌面端嵌入块里 CAD 的 ribbon / 命令行 / 状态栏、文件预览的侧栏都看得见。

**要彻底修，得让被借用的应用自己认一个 URL 参数来自藏外壳**（如 `?bare=1`），
而不是靠宿主页注入 —— 浏览器同源策略没有第三条路。
各家应用的实现与回归清单见各自仓库的 `UPGRADING.md`。

### 通道前缀改动要两边同步

前缀与端口定义在 `siyuannote-fnos-app` 的 `reverse-proxy.py`（`PROXY_*_PREFIX`）
与 `cmd/main`，插件侧在 `api.js`（`CAD_PREFIX` / `FV_PREFIX` / `DOCS_PREFIX`）。**改一处必须改两处。**

---

## 5. 插件 API 的三个陷阱

思源内核插件 API 有**三条路径是"200 空体"陷阱**（SPA 兜底），写代码前必读：

| 用途 | ✅ 正确 | ❌ 无效 |
|---|---|---|
| 写数据 | `/api/file/putFile`（multipart FormData，`path` = `/data/storage/petal/<插件名>/<name>`，**无扩展名**，`file` = Blob） | `/api/petal/savePluginData`（**不存在**） |
| 读数据 | `/api/file/getFile`（POST `{path}`） | `/api/getFile` |
| 停靠项 / 页签图标 | `addIcons('<symbol id="iconXxx" viewBox="0 0 32 32">…')` + `addDock({config:{icon:"iconXxx"}})` | 直接传整段内联 SVG（**渲染成空白且不报错**） |

★ **读的 API 没确认过就别写**。核对"读回一致"必须用**同一条能真读到内容的通道**，
否则"两边都是空"也会显示"一致" —— 真机上踩过，把用户的真设置写成了 0 字节。

★ 探活必须核对身份：只判 `ok:true` 会认错人（裸根 `/api/health` 答的可能是别的应用）。
正解 = 认死 `app === "siyuan-local-fs"`。

---

## 6. 测试纪律

**整段归零（0 通过 / 1 失败）= 文件没跑起来（语法错）**，真报错在 **stderr**。

**绝不为"让测试变绿"改产品代码。**

---

## 7. 仓库约定

- `dist/` / `dist-package/` / `vendor/` 都是构建产物，不入库。
- 口令、token 一律不进版本库；`tools/.nb-local.json`、`.gh-token` 已 gitignore。
- `.verify/` 里含真实 NAS 凭据与 Chrome 配置 ⇒ **绝不可入库**。
- `.workbuddy/`（工作区记忆，可能含真实口令与 token）⇒ **绝不可入库**。
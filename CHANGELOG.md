# 更新日志

## v1.7.1 — 2026-11-18

**修「识别失败：二维码解码器未加载」。**

上一版把 jsQR 做成「点扫码时才懒加载」，某些 Chromium 版本在那个时机拿不到
`importScripts` 的结果，于是整条链路直接失败。现在：

- **启动时就同步加载** `vendor/jsqr.js`（和 Firefox 的静态引入一致，这是
  `importScripts` 最可靠的时机）
- 兜底通道：万一还是没拿到，就用 `await import('vendor/jsqr.mjs')`
  —— 动态 import 不依赖 `importScripts`，也不需要 `unsafe-eval`
- 失败不再是白框一次：点 ▣ 时先确保解码器就位，拿不到就直接报原因
  （`二维码解码器没加载出来：<真实报错>`），并提示可改用粘贴密钥 / 截图导入
- 新增 `qr.diag` 自检路由，返回 `{jsQR, importScripts, error, moduleUrl}`
- **新增 `test/qr-load.mjs`**：模拟 service worker 用 `importScripts` 真读
  `vendor/jsqr.js` → 用 `vendor/qrcode.js` 造一张二维码像素图 → 用
  `lib/qr.js` 的 `decodeImageData` 解出原文 → 再验一遍 ESM 兜底也能解。
  这条链路以前没人测，才让这个 bug 跑到用户手上。


## v1.7.0 — 2026-11-18

**扫码改成「一次点击」为主：能直接认出来，就不打扰你。**

参考 Authenticator 扩展的做法（页面变暗 → 拖框 → 松手即识别），并在此基础上加了一条快速路径：

1. 点 ▣ → 截一张当前可见区域 → **先在整屏上试一次**
2. **认出来了** → 直接导入，页面上弹一句「已导入 1 条：GitHub」→ 结束（零操作、无浮层）
3. **没认出来** → 页面变暗，拖动框住二维码 → 松手识别 → 只解码框住的那一块 → 弹结果

改动细节：

- 浮层不再用「冻结的整屏截图」当背景，改成半透明变暗 + 实时页面（看不到整张图，和 Authenticator 一致）
- 框选时才重新截屏，且**截之前先把浮层隐藏**（否则绿框会进截图）
- 结果提示和错误提示都做成页面内的小药丸 toast
- 后台抽出 `decodeAndImport()`：解码 → 分派 → 导入 → 更新徽标，两条路径共用
- 仍然只申请 `activeTab`，没有新权限

### 测试

`test/ui.mjs`（22 组）把网页扫码拆成三条路径验证：

- **A 一次点击**：整屏能认出 → 断言弹窗自动关闭、**浮层从未出现**、页面出现「已导入 1 条：OneClick」、条目真的进库
- **B 框选**：整屏认不出 → 浮层出现 → 反向拖动 → 断言只解码了 `{x:320,y:260,w:280,h:240}` 且带上视口尺寸、截了第二次图 → 导入 → 浮层撤掉
- **C 负向**：框里没二维码 → 提示「这块区域没有二维码」；过小的框不触发解码；`Esc` 能关


## v1.6.0 — 2026-11-18

**框选改到「原页面」上做，不再弹新窗口。**

1. 弹窗点 **▣** → 截一张当前可见区域
2. 弹窗立刻关闭，**当前网页上盖一层截图浮层**（1:1 冻结画面，带半透明选区）
3. 拖动框住二维码 → 松手识别 → 浮层上显示「已导入 N 条」→ 1.2 秒后自动消失
4. `Esc` 随时退出；框里没有二维码时浮层保留提示，可以接着再框

改动细节：

- 新增内容脚本 `content/overlay.js`（约 4 KB，跟随已有的自动填充脚本注入，**不需要新权限**）
- 解码搬到后台：`lib/qr.js` 新增 `decodeDataUrlRegion()`，用 `fetch → createImageBitmap → OffscreenCanvas` 按矩形裁剪（Chromium 的 service worker 没有 DOM 也能跑）；jsQR 在 Chromium 侧**懒加载**（`importScripts`），Firefox 侧静态引入
- 删除 v1.5.0 的 `selector.html` 独立窗口
- 坐标换算用 `窗口 CSS 像素 → 截图设备像素`（`devicePixelRatio` 由后台按 bitmap 尺寸自动处理），所以 2×/3× 屏也框得准
- 小于 8×8 px 的框忽略；同步配对码 / 加密备份文件仍然只提示去设置页处理

### 测试

`test/ui.mjs`（22 组）里的网页扫码用例整体重写：真实注入 `content/overlay.js` 到“页面”上下文，点 ▣ → 断言**没有打开任何窗口**、弹窗自己关掉、浮层出现在页面 DOM 里 → 反向拖动得到 `{x:320,y:260,w:280,h:240}` 并带上视口尺寸 → 只解码这一块 → 导入成功 → 浮层自动撤掉；另外覆盖「框里没有二维码」「过小的框被忽略」「Esc 关闭」「normalize 归一化」。


## v1.5.0 — 2026-11-18

**网页扫码改成「框选」：只解码你框住的那一块。**

以前点 ▣ 是把整张截图丢进解码器，页面上有多个二维码（或者二维码旁边有别的图案）时容易读错。现在流程是：

1. 弹窗点 **▣** → 后台截一张当前可见区域
2. 弹出独立小窗口，显示**原始分辨率**的截图（1:1，不缩放，可滚动）
3. 拖动框住二维码 → **松手即识别**，只把这一个矩形裁出来送进解码器
4. 识别成功 → 导入 → 窗口 1.3 秒后自动关闭

细节：

- 反方向拖、拖出界都会归一化/裁剪到有效范围；小于 8×8 px 的框直接忽略（防误触）
- 选区里没有二维码 → 明确提示「试着框得再紧一点，或者用『整张图识别』」
- 保留「**整张图识别**」按钮作为兜底
- 仍然复用 `scan.handle` 分派：`otpauth://`、迁移包、Passkey 条目码都能导入；同步配对码 / 加密备份文件会提示去设置页处理
- 新增 `lib/qr.js` 的 `cropImageData(source, rect)`（按矩形裁剪出 ImageData）
- 弹窗不再加载 jsQR（解码搬到了框选窗口），弹窗打开更快

### 测试

- `test/ui.mjs` 一组覆盖全链路（共 22 组）：点 ▣ → 截图进 `storage.session` → 打开 `type:'popup'` 的框选窗口 → 反向拖动得到 `{x:260,y:180,w:240,h:220}` 的裁剪矩形 → 导入成功；另外验证「过小选区被忽略」「空选区给出可读提示」「`normalizeRect` 归一化」
- 顺手修掉一处 30 秒边界抖动（验证码断言接受上一时间窗的码）


## v1.4.0 — 2026-11-18

**新增：扫描当前网页上的二维码。**

点工具栏图标 → 弹窗左上角 **▣** → 自动截取当前标签页、识别二维码、直接导入，不用再截图再粘贴。

- 后台新增 `qr.capture`：`captureVisibleTab` 截图后以 data URL 回传，解码仍在弹窗里做（弹窗有 canvas，MV3 的 service worker 没有）
- 走的是和粘贴/拖图完全相同的 `scan.handle` 分派：`otpauth://`、迁移包、Passkey 条目码都能直接导入；同步配对码与备份文件会提示去设置页处理（避免在弹窗里做危险操作）
- 识别不到时给可读提示（「把二维码放大一点再试」），截屏失败按原因区分（权限 / 浏览器内部页面 / 其他）
- 新增 `activeTab` 权限（只在点到这个按钮时生效，不常驻授权）
- 设置页的扫码区补了一句引导，说明网页扫码入口在弹窗里

### 测试

- `test/ui.mjs` 新增一组：截屏 → 解码 → 导入成功（条目真的进了保管库）+ 识别不到时提示文案可读；共 22 组


## v1.3.2 — 2026-11-18

- 新增 **`PRIVACY.md`**：说明扩展无服务器、备份只写进使用者自己的网盘、作者能看到什么（云平台应用级日志，不含文件内容）
- README 新增「分发说明：内置客户端意味着什么」：使用者 / 作者各自看得到什么，以及作者的三个责任（单点失效、被冒用、责任边界）
- OneDrive 面板的内置提示补一句「备份只会写进你自己的网盘，开发者看不到你的任何数据」


## v1.3.1 — 2026-11-18

- **「内置客户端」变成一行配置**：`BUILTIN_CLIENTS` / `BUILTIN_SECRETS` 里填了 ID，设置页的徽标自动从「需注册」变「已内置」，客户端 ID 自动预填 —— Google Drive、Dropbox 都能这样开启，不用改 UI 代码
- 新增 `BUILTIN_SECRETS`：应付 Google「Web 应用」客户端换 token 必须带 `client_secret` 的限制（微软那边是纯 PKCE，不需要）
- README 新增「Google Drive 一键连接」三条路线对比（内置 ID+secret / 用户自填 / 上架商店用 Chrome 扩展客户端），并标注 Google 的 **7 天 refresh token** 陷阱（必须把发布状态改成 In production）
- 测试：`test/providers.mjs` 20 项（+1，验证内置 ID+secret 时授权 URL 只申请 `drive.file`、带 PKCE、带 `access_type=offline`，token 交换带 `client_secret`）；`test/ui.mjs` 新增「填一行 ID 后 Google 自动变『已内置』并预填」


## v1.3.0 — 2026-11-18

**主题：OneDrive 变成「点一下就能连」。**

- 内置本扩展自己注册的**公开客户端 ID**（`providers.js` 的 `BUILTIN_CLIENTS`）：用户装好扩展 → 点「连接 OneDrive」→ 登录 → 接受，**不需要去 Azure 注册任何东西**
- 设置页 OneDrive 面板：客户端 ID 自动预填并显示「用内置」还原按钮，顶部有「点一下就能连」提示；渠道标签新增蓝色 **「已内置」** 徽标
- 三态徽标：`免注册`（文件夹/对象存储/WebDAV）· `已内置`（OneDrive）· `需注册`（Google Drive / Dropbox）
- 只有 ID、没有密钥 —— 公开客户端的 ID 本来就会出现在授权 URL 里，写进代码是安全的；想要自己的应用，把 ID 换掉即可（以用户填的为准）
- 文档补充分发注意事项：微软限制「未通过发布者验证的多租户应用」不能被其他组织账号自行同意（个人账号不受影响）

### 测试

- `test/providers.mjs` +3：未填 ID 时授权 URL 自动带内置 ID 且走 PKCE、只申请 `Files.ReadWrite.AppFolder offline_access`、不提交 `client_secret`；用户自填 ID 时以用户的为准（19 项）
- `test/ui.mjs` 新增：OneDrive 面板预填内置 ID、显示「点一下就能连」提示、回调地址形状正确、徽标为「已内置」（19 组）


## v1.2.1 — 2026-11-18

- **固定 Chromium 扩展 ID**（manifest 内置 `key`）：扩展 ID 恒为 `ahkfbinhhpfhjdmogafkgfecajfldmal`，回调地址恒为 `https://ahkfbinhhpfhjdmogafkgfecajfldmal.chromiumapp.org/`，OAuth 重定向 URI 只需注册一次
- README 新增「在 Azure 注册 OneDrive 应用（手把手，约 3 分钟）」：账户类型怎么选、平台必须选 **SPA**（选 Web 会要求 client_secret）、只要一个 `Files.ReadWrite.AppFolder` 权限、Firefox 回调地址怎么加第二条，以及 `AADSTS50011 / 65005 / 7000218 / 50020` 四类报错对照表

> 注意：扩展 ID 变了，等于一个新的扩展实例。如果你已经装过旧版本并录入过账户，先「导出文件」备份，换新版后再导入。

## v1.2.0 — 2026-11-18

**主题：网盘备份不再需要注册开发者应用。**

### 新增：三条「免注册」备份通道

| 通道 | 你需要准备 |
| --- | --- |
| **文件夹同步**（零配置） | 什么都不用。备份写入下载目录，由系统里的 OneDrive / iCloud / 坚果云桌面客户端同步 |
| **对象存储 S3** | 一对 AccessKey + SecretKey。预设：AWS、Cloudflare R2、Backblaze B2、MinIO、阿里云 OSS、腾讯云 COS |
| **WebDAV 网盘** | 账号 + 应用密码。预设一键填地址：坚果云、Nextcloud、群晖、pCloud、Koofr、Yandex、InfiniCLOUD |

- S3 实现**不依赖任何 SDK**：用 WebCrypto 手写 AWS SigV4 预签名（`UNSIGNED-PAYLOAD`、只签 `host`、默认 900 秒过期），拿到 URL 后直接 PUT/GET
- 权限按需申请：首次使用某个 endpoint 时才动态请求该域名的可选权限
- 渠道标签直接标注「免注册 / 需注册」；选预设即自动填地址与区域
- 通过 AList / OpenList 的 `/dav` 网关，可以间接接上百度网盘、阿里云盘等没有 WebDAV 的网盘

### 变更

- OAuth 三家（Google Drive / Dropbox / OneDrive）降级为备选路径，但仍完整保留
- 新增 `downloads` 权限用途说明（文件夹同步写入下载目录）
- README 第二节重写为「先挑不用注册的」，补充 CORS 最小配置与常见报错

### 测试

- 新增 `test/s3.mjs`：15 项。其中 4 组预签名 URL 与 Python `botocore` 输出**逐字节一致**（AWS 基础路径 / R2 端点 + 非 ASCII 键名 / 带端口的 MinIO / EU 区域）；另有独立重建 SigV4 验签的服务器跑通 PUT → GET → 恢复，错误 SecretKey 返回 403
- 全量回归：**82 项**单元测试 + 17 组 jsdom UI 断言；`web-ext lint` 0 error / 0 warning / 0 notice
- GitHub Actions 自动跑测试、打包、lint，并上传三个 zip 作为 artifact

---

## v1.1.0 — 2026-11-17

- **二维码扫码导入**：拖图 / 粘贴 / 摄像头三种入口，支持 `otpauth://`、Google Authenticator 迁移包、Passkey 记录、同步配对码
- **Passkey / WebAuthn 记录存放**：加密存储、详情展示、二维码与 JSON 迁移（**不能代答 WebAuthn，网站登录仍需系统认证器**）
- **`storage.sync` 端到端加密同步**（iCloud 钥匙串式）：配对码派生密钥、分片写入、云端只有 AES-GCM 密文，按插件配额（单项 8 KB / 总量 100 KB）自动分片

## v1.0.0 — 2026-11-16

首个可用版本：TOTP 保管库、网页自动填充、本地定期快照、可选主密码加密（AES-256-GCM + PBKDF2）、WebDAV 与三家 OAuth 网盘备份、Firefox / Edge / Chromium 三目标打包。

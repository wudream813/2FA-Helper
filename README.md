# 2FA Helper

一个**离线优先**的 TOTP（两步验证）保管库浏览器扩展，可同时用于 **Firefox / Edge / Chromium（Chrome、Brave、Vivaldi…）**。

- 本地生成验证码，不经过任何服务器
- **本地定期保存**：自动快照 + 可选定期导出文件到下载目录
- **三种「免注册」备份通道**（填账号密码就能用，见第二节）：
  - **文件夹同步**：零配置，写进下载目录，靠 OneDrive / iCloud / 坚果云桌面客户端带走
  - **对象存储（S3 兼容）**：AccessKey + SecretKey 直连 AWS / R2 / B2 / MinIO / OSS / COS
  - **WebDAV 网盘**：坚果云、Nextcloud、群晖、pCloud、Koofr、Yandex、InfiniCLOUD 预设一键填地址（AList 网关可挂百度网盘等任意网盘）
- **知名网盘备份**：Google Drive、OneDrive、Dropbox（OAuth，需自建客户端，作为备选）
- **端到端加密同步**：`storage.sync` 分片同步，云端只有 AES-GCM 密文（见第四节）
- **二维码**：扫码导入（拖图 / 粘贴 / 摄像头）+ 为每个条目生成二维码
- **Passkey / WebAuthn 记录**：加密存放、展示、二维码与 JSON 迁移（见第三节的边界说明）
- **登录页自动填充**：识别验证码输入框，点一下填入
- 可选主密码加密：本地存储与云端备份文件均为 AES-256-GCM 密文
- 导入能力强：`otpauth://` 链接、Google Authenticator 导出包（`otpauth-migration://`）、JSON

> 版本 1.2.0 · Manifest V3 · 运行时零依赖（二维码编解码的可信实现以 vendor 形式内置，见 `src/vendor/LICENSES.md`）

---

## 一、5 分钟上手

```bash
cd 2fa-helper
npm install            # 只有一个 dev 依赖（jsdom），运行时零依赖
npm run build          # 生成 release/chromium、release/edge、release/firefox 以及三个可分发 .zip
npm test               # 82 项测试：RFC 算法向量、加密信封、保管库、备份渠道网络层（含 S3 真服务器验签）、同步、二维码
npm run test:ui        # jsdom 里的端到端 UI 测试（真背景脚本 + 真页面）
npm run test:all       # 全部
```

### 安装

**方式一：直接下载现成安装包**（推荐）

到 [Releases](https://github.com/wudream813/2FA-Helper/releases/latest) 下载对应压缩包并解压：

| 文件 | 用于 |
| --- | --- |
| `2fa-helper-chromium-1.2.0.zip` | Chrome / Chromium / Brave / Vivaldi |
| `2fa-helper-edge-1.2.0.zip` | Edge（与 chromium 包内容相同，同用 MV3 manifest） |
| `2fa-helper-firefox-1.2.0.zip` | Firefox |

**方式二：自己构建，用开发者模式加载**


| 浏览器 | 操作 |
| --- | --- |
| **Chrome / Chromium / Brave / Vivaldi** | `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 `release/chromium` |
| **Edge** | `edge://extensions` → 左侧「开发人员模式」→「加载解压缩的扩展」→ 选 `release/edge` |
| **Firefox** | `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选 `release/firefox/manifest.json` |

> Firefox 也可以直接用 `release/2fa-helper-firefox-1.2.0.zip` 在 `about:addons` → 齿轮 → 「从文件安装附加组件」中安装（需要先用 `web-ext sign` 或关闭签名校验的开发版）。
> Firefox 的 MV3 里 host 权限默认不授予：装好后请到 `about:addons` → 2FA Helper → **权限** → 勾选「访问所有网站的数据」，否则网页自动填充与 WebDAV 请求会被拦截。

### 第一步：加一个账户

1. 点浏览器工具栏的扩展图标
2. 点 `＋`，填站点名、账户、Base32 密钥（服务商给的「手动设置」密钥），可选填自动填充域名（如 `github.com`）
3. 列表里点任意一行 = 复制验证码（圆环是剩余秒数，最后 5 秒变红）

更快的方式：复制 `otpauth://…` 链接后**直接按 Ctrl+V**，弹窗会识别并导入。

---

## 二、备份渠道：先挑「不用注册」的

| 渠道 | 要注册开发者应用吗 | 你需要准备 | 适合谁 |
| --- | --- | --- | --- |
| **文件夹同步** | 不用 | 什么都不用 | 新手；系统里已经装了 OneDrive / iCloud / 坚果云 桌面客户端 |
| **对象存储（S3）** | 不用 | AccessKey + SecretKey（后台一键生成） | 想最稳最快；已有 R2 / B2 / MinIO / OSS |
| **WebDAV 网盘** | 不用 | 账号 + 应用密码 | 有坚果云 / Nextcloud / 群晖；或用 AList 网关接任意网盘 |
| Google Drive / Dropbox / OneDrive | **要**（3~5 分钟建 OAuth 客户端） | Client ID + 回调地址 | 只想用这三家，且不介意注册 |

设置页里前三种带绿色「免注册」徽标，后三种带灰色「需注册」。它们上传的是**同一个加密信封**，可以同时配多个，内容完全一致。

> 为什么 OAuth 那三家要注册？扩展不允许内置开发者密钥（会被厂商判定为滥用并封禁）。所以那三条路只能你自己建客户端——这就是把它排到最后的理由，不是功能缺失。

---

### 2.1 文件夹同步（零配置，最省事）

设置页 → 备份渠道 → **文件夹同步**。只有一个输入框「子路径」，默认 `2FA-Helper/2fa-helper-backup.json`。

它做的事很朴素：**把加密备份写进浏览器的下载目录**（同名覆盖，不弹「另存为」对话框），剩下的交给系统里已经在跑的网盘客户端。

推荐用法——把**浏览器的默认下载位置**直接指到网盘的本地文件夹：

| 网盘 | 把下载目录设成 |
| --- | --- |
| OneDrive | `C:\Users\你\OneDrive\2FA` |
| iCloud Drive（macOS） | `~/Library/Mobile Documents/com~apple~CloudDocs/2FA` |
| 坚果云 / Dropbox / Google Drive 桌面版 | 各自的本地同步文件夹 |

然后子路径填 `2fa-helper-backup.json`。备份完 5 秒内它就会出现在你的网盘里，手机、另一台电脑都能拿到。

- 好处：**不需要任何账号密码、无 CORS、无注册**，跨所有浏览器可用
- 恢复：设置页 →「从文件恢复」→ 选那个 json（扩展不读下载目录，所以是手动选一次）
- Chromium MV3 的 service worker 里没有 `URL.createObjectURL`，实现上会自动改用 data URL 写入——两条路径都有测试覆盖
- 已知限制：极少数 Chromium 版本会限制 `data:` 形式的下载；如果「立即备份」没在下载目录看到文件，改用对象存储或 WebDAV 即可（文件夹同步只做写入，不做读取校验）

---

### 2.2 对象存储（S3 兼容，一个密钥串搞定）

设置页 → **对象存储**。先在下拉里选预设，端点和区域自动填好：

| 预设 | Endpoint | Region |
| --- | --- | --- |
| AWS S3 | `https://s3.us-east-1.amazonaws.com` | `us-east-1`（换成你的区） |
| Cloudflare R2 | `https://<账户ID>.r2.cloudflarestorage.com` | `auto` |
| Backblaze B2 | `https://s3.us-west-004.backblazeb2.com` | `us-west-004` |
| MinIO / 自建 | `http://127.0.0.1:9000` | `us-east-1` |
| 阿里云 OSS | `https://s3.oss-cn-hangzhou.aliyuncs.com` | `cn-hangzhou` |
| 腾讯云 COS | `https://cos.ap-guangzhou.myqcloud.com` | `ap-guangzhou` |

再填桶名、对象路径（默认 `2fa-helper/backup.json`）、AccessKey、SecretKey →「测试连接」。

**实现没有引入任何 SDK**：用 WebCrypto 手写 AWS SigV4，对 PUT/GET 各生成一条预签名 URL（`UNSIGNED-PAYLOAD`、只签 `host`、默认 900 秒过期），然后直接 `fetch`。

两件必须做的事：

1. **给桶开 CORS**（否则浏览器会拦下跨域请求）。最小规则：

   ```xml
   <CORSConfiguration><CORSRule>
     <AllowedOrigin>*</AllowedOrigin>
     <AllowedMethod>GET</AllowedMethod>
     <AllowedMethod>PUT</AllowedMethod>
     <AllowedMethod>HEAD</AllowedMethod>
     <AllowedHeader>*</AllowedHeader>
   </CORSRule></CORSConfiguration>
   ```

   R2 / B2 / OSS / COS 的后台都有图形界面的「跨域设置」。
2. **首次使用会弹一次权限申请**：扩展按你的 endpoint 域名动态申请可选权限（`permissions.request`），不授予就无法发请求。换 endpoint 会再问一次。

> 安全建议：单独建一个**只能读写这一个桶**的密钥（R2 的 API Token 可以精确限定桶与权限），这样即使泄露也只影响备份文件——而备份文件本身还是密文。

---

### 2.3 WebDAV 网盘（预设一键填地址）

设置页 → **WebDAV**，先在预设下拉里挑服务商，地址会自动填好，你只补账号和**应用密码**：

| 预设 | 地址 | 密码用什么 |
| --- | --- | --- |
| 坚果云 | `https://dav.jianguoyun.com/dav/2fa-helper/backup.json` | 「账户信息 → 安全选项 → 添加应用密码」 |
| Nextcloud | `https://your-host/remote.php/dav/files/<用户名>/2fa/backup.json` | 设置里生成应用密码 |
| 群晖 NAS | `https://your-nas:5006/2fa/backup.json` | DSM 密码（需装 WebDAV Server 套件；5005=HTTP） |
| **AList / OpenList** | `http://your-alist:5244/dav/2fa-helper/backup.json` | AList 账号 |
| pCloud | `https://webdav.pcloud.com/2fa-helper/backup.json` | 账号密码（欧盟区用 `ewebdav.pcloud.com`） |
| Koofr | `https://app.koofr.net/dav/Koofr/2fa-helper/backup.json` | 可生成专用应用密码 |
| Yandex Disk | `https://webdav.yandex.ru/2fa-helper/backup.json` | Yandex ID 里生成应用密码 |
| InfiniCLOUD | `https://your-id.teracloud.jp/dav/2fa-helper/backup.json` | 「应用程序连接」里启用 WebDAV |

**想用百度网盘 / 阿里云盘 / 夸克这类没有 WebDAV 的网盘？** 在 AList 里把它们挂载好，扩展只连 AList 的 `/dav` 就够了——一次配置等于接上所有网盘。这是目前最通用的「免注册」解法。

点「测试连接」→ 出现「连接正常，目标文件尚不存在」即成功。首次备份会自动尝试创建目录（服务端允许时）。

---

### 2.4 三家 OAuth 网盘（要注册开发者应用）

只有在上面三条路都走不通时才建议动这三家。它们共用一个**回调地址**：设置页里对应面板顶部那行等宽字体地址，旁边有「复制」按钮。

> 每个浏览器的扩展 ID 不同（Firefox 是 `https://<uuid>.extensions.allizom.org/`），换浏览器要为新地址重复「填回调地址」这一步，或者干脆把多个地址都加进平台的白名单。

#### Google Drive

1. [Google Cloud Console](https://console.cloud.google.com/) → 新建项目 → 「API 和服务」→ 启用 **Google Drive API**
2. 「OAuth 同意屏幕」→ 外部 → 测试用户里加上你自己的邮箱
3. 「凭据」→ 创建凭据 → **OAuth 客户端 ID** → 应用类型 **Web 应用** → 「已获授权的重定向 URI」粘贴上面那个回调地址
4. 把 **Client ID** 粘进扩展；**Client Secret** 可留空先试 PKCE，报 `client_secret is missing` 再填
5. 点「连接 Google 账号」→ 弹窗授权

权限只要 `drive.file`（只能看见本扩展自己创建的文件）。

#### Dropbox

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) → Create app → **Scoped access**
2. Permissions 勾选 `files.content.write` 与 `files.content.read` → Submit
3. Redirect URIs 填同一个回调地址
4. 把 **App key** 粘进扩展 →「连接 Dropbox」（PKCE，不需要 App secret）

#### OneDrive

1. [Azure 门户](https://portal.azure.com/) →「应用注册」→ 新注册（「个人 Microsoft 账户」+ 工作/学校）
2. 「身份验证」→ 添加平台 → **Web** → 重定向 URI 填回调地址；同时打开「允许公共客户端流」
3. 「API 权限」→ Microsoft Graph → 委托的权限 → `Files.ReadWrite.AppFolder`
4. 复制「应用程序(客户端)ID」到扩展 →「连接 OneDrive」

备份写入应用专属的 **App Folder**（`应用名/2fa-helper-backup.json`），不碰你其他文件。

---

## 三、二维码与 Passkey

### 3.1 扫码导入

设置页 →「二维码扫码导入」，三种入口：

| 方式 | 说明 |
| --- | --- |
| 拖入 / 选择图片 | 截图、下载的二维码图都行（png/jpg/webp/gif/bmp） |
| `Ctrl`+`V` | 直接把截图粘进来（弹窗里也支持粘贴 `otpauth://` 文本） |
| 摄像头 | 点「使用摄像头扫码」，手机/带摄像头的电脑对准即可；识别成功会自动停止 |

能识别的内容：

- `otpauth://`（任意验证器导出的单条账户）
- `otpauth-migration://`（Google Authenticator 导出包）
- `f2a-passkey:v1:…`（本扩展的 Passkey 记录码，**不含私钥**）
- `f2a-sync:v1:…`（同步配对码，扫码即加入同步组）
- 本扩展的 `.json` 备份文件（识别后会让你确认是否覆盖）

解码用的是内置的 jsQR（Apache-2.0），在 2px/模块的低分辨率下也能识别，测试里还与 Python 的 `qrcode` 库做了交叉验证。

反过来，每个条目都能生成二维码：弹窗里点条目 → 右上「ⓘ」→ 详情页有二维码；验证码条目输出标准 `otpauth://`，手机上的任意验证器都能直接扫走。

### 3.2 Passkey / WebAuthn 存放（请注意边界）

**能做的**：把 Passkey 记录加密存进同一个保管库——RP ID、用户名、userHandle、credentialId、公钥（SPKI/COSE）、算法、签名计数、备注，以及（可选）你自己托管的私钥 JWK。随保管库一起加密、一起备份、一起同步；可以显示二维码或用 JSON 导出去迁移到别处；地址栏和列表里用 `PASSKEY` 标记区分，不会误当成验证码。

**做不到的（浏览器限制，不是实现取巧）**：扩展无法替网站完成 WebAuthn 登录。Chrome / Firefox 都没有向扩展开放 authenticator / CTAP 接口，网站调用 `navigator.credentials.create/get` 时不会问到扩展。真正能用起来的 Passkey 需要系统级认证器（Touch ID / Windows Hello）或平台协议支持。

所以这里的定位是「**加密的 Passkey 台账 + 迁移中转站**」：换机、交接、审计时把记录带得走。表单里的「生成软件密钥对」会生成 ES256 密钥并保存在加密保管库里，方便你在自建系统里使用这对密钥，但它同样不会让浏览器认识它。

## 四、端到端加密同步（iCloud 钥匙串式）

设置页 →「端到端加密同步」→ **启用并生成配对码**。

- 数据写入浏览器账号自带的 `storage.sync`（Chrome/Edge 登录账号、Firefox Sync），**不经过任何第三方服务器**
- 内容用一把随机 256 位**同步密钥**做 AES-256-GCM 加密；这把密钥只在你的设备间存在，浏览器服务商只能看到密文
- 因为 `storage.sync` 有「单项 8 KB / 总量 100 KB」的硬限制，记录会被切成 ~6 KB 的分片（`f2a.sync.c0…`），最后写入的 `f2a.sync.meta` 充当提交标记；读取时按 meta 拼装并校验 SHA-256，缺片/被篡改会明确报错而不是静默丢数据

### 配对第二台设备

两种方式，效果一样：

1. **扫**：旧设备点「显示二维码」，新设备用设置页的扫码功能扫它
2. **抄**：旧设备「复制」52 位配对码（形如 `A1B2-C3D4-…`），新设备点「我有配对码」粘贴

配对后新设备会立刻知道云端有没有数据；点「从云端拉取」应用（若是加密保管库，会要求输入**主密码**，即双层解密）。

### 冲突与自动行为

| 场景 | 行为 |
| --- | --- |
| 本地有改动 | 改动后 10 秒自动推送（可关），另每 60 分钟兜底推一次 |
| 云端比本机新 | 弹窗底栏出现「云端有更新 ⟳」，不会自动覆盖本机，需你点「从云端拉取」 |
| 内容与云端完全一致 | 跳过推送，避免两台设备来回互推；拉取后还会静默 30 秒 |
| 配对码错误 | 加入失败并自动回滚，不会留下半启用状态 |
| 数据超过 90 KB | 明确报错并提示，不会悄悄失败 |

**配对码丢了怎么办**：云端密文无法恢复（这正是它安全的原因）。请在密码管理器里存一份配对码——或者至少保证一台设备还在，从它那里重新显示二维码。

## 五、备份文件长什么样

```json
{
  "app": "2FA Helper",
  "format": "f2a-vault",
  "version": 1,
  "createdAt": "2026-11-18T02:11:03.442Z",
  "encrypted": true,
  "kdf": { "algo": "PBKDF2-SHA256", "iterations": 250000, "salt": "…" },
  "cipher": { "algo": "AES-GCM-256", "iv": "…" },
  "payload": "…base64 密文…",
  "meta": { "entryCount": 27 },
  "exportedAt": "…",
  "generator": "2FA Helper"
}
```

- 未加密时是 `"encrypted": false` + `"data": { entries: [...] }`
- `meta.entryCount` 是唯一明文信息（方便恢复前确认条数），未包含任何站点名/密钥
- 同一格式同时用于：`storage.local` 里的保管库、本地快照、以及所有云端备份文件

### 三层保存策略

| 层 | 触发时机 | 位置 | 默认 |
| --- | --- | --- | --- |
| 主保管库 | 每次改动即时写入 | `storage.local` | 开 |
| 本地快照 | 改动后 10 秒 + 每 6 小时 | `storage.local`（滚动保留 10 份） | 开 |
| 文件导出 | 每 7 天 / 手动 | 下载目录 `.json` | 关 |
| 云端备份 | 每 12 小时 / 手动「立即备份」 | 下载目录（文件夹同步）/ S3 / WebDAV / 云盘 | 关 |

日期、间隔、保留份数都能在设置页改。恢复入口有三个：**从云端恢复**、**本地快照 → 恢复**、**从文件恢复**。恢复一律需要覆盖确认；加密备份在恢复时会要求输入备份时的主密码。

---

## 六、安全模型（请读完）

**做了什么**

- TOTP 计算在本地完成（WebCrypto HMAC-SHA1/256/512），已验证 RFC 4226 / RFC 6238 官方向量（含 SHA256/SHA512）
- 主密码经 PBKDF2-SHA256（250,000 次）派生 → AES-256-GCM，每条记录写入时换新 IV
- 错误主密码由 GCM 认证标签直接拒绝，不依赖额外校验字段
- 自动填充时，网页只能拿到 `autofill.match`（站点名/账户名）和 `autofill.code`（6 位码），**永远拿不到 secret**
- 自动填充按钮只在域名匹配的页面上出现，且使用 Shadow DOM，宿主页面 CSS/JS 无法干预

**明确没有做的事（请对症下药）**

1. **备份渠道的凭据以明文存在扩展本地存储**（`storage.local` 的 `secrets` 键）：WebDAV 应用密码、S3 的 SecretKey、OAuth 刷新令牌。原因：定时备份要在保管库锁定时也能运行。
   缓解：坚果云等用**独立应用密码**（可随时吊销）；共用电脑就把「定时上传」关掉，只手动备份；不放心就只启用加密备份 + 手动上传。
2. **主密码忘记 = 数据无法恢复**。没有找回、没有后门。请把主密码记在密码管理器/纸上。
3. **不加主密码 = 明文存盘**。任何能读到浏览器 profile 目录的人都能拿到密钥。共用设备请务必设主密码。
4. **OAuth 客户端是你自己的**：Client Secret 若填写，也存在本地；Google 的 secret 对「Web 应用」类型并非真正保密，安全性依赖 PKCE + 你账号的授权。
5. 一次性密码（HOTP）支持计数递增，但不会自动同步计数器，多设备使用时请留意。
6. **同步密钥（配对码）明文存在 `storage.local` 的 `secrets` 里**，和 WebDAV 应用密码同样处理：能读到浏览器 profile 的人，也能解密你浏览器账号里的同步密文。共用设备请关掉同步或改用主密码加密保管库（此时云端是「同步密钥 + 主密码」双层加密）。
7. **Passkey 不能自动登录网站**（见 3.2），扩展也没有申请任何与 WebAuthn 相关的接口。
8. 二维码解码器（jsQR，Apache-2.0）与编码器（qrcode-generator，MIT）以源码形式内置，运行时不联网、不加载远程脚本。

**权限说明**

| 权限 | 用途 |
| --- | --- |
| `storage` / `unlimitedStorage` | 保管库、快照、设置 |
| `alarms` | 定时快照与定时备份 |
| `identity` | 云盘 OAuth 授权 |
| `downloads` | 「导出文件」、定期导出，以及**文件夹同步**写入下载目录 |
| `permissions` | 首次使用 WebDAV / S3 时按站点动态申请权限（可选权限，不是全局授权） |
| `content_scripts`（全部站点） | 登录页验证码自动填充，可在设置里一键关闭 |
| `host_permissions`（仅云盘 API 域名） | Google / Dropbox / Microsoft 接口 |
| 摄像头（运行时询问，不进 manifest） | 扫码导入；不授权也能用拖图/粘贴 |

同步只用到已有的 `storage` 权限（`storage.sync` 是它的子集），**没有**新增任何权限。

---

## 七、项目结构

```
2fa-helper/
├── src/
│   ├── manifest.chromium.json     # Chrome / Edge / Chromium 用（service worker）
│   ├── manifest.firefox.json      # Firefox 用（background scripts + gecko id）
│   ├── background.js              # 消息路由、定时任务、徽标、快照触发
│   ├── lib/
│   │   ├── util.js                # Base32 / Base64 / 工具，跨浏览器 API 适配
│   │   ├── totp.js                # TOTP/HOTP 引擎、otpauth 与迁移包解析
│   │   ├── crypto.js              # 信封格式 + PBKDF2/AES-GCM
│   │   ├── vault.js               # 存储层、锁定状态机、快照、OTP+Passkey 条目模型
│   │   ├── providers.js           # 6 个渠道：文件夹 / S3(SigV4) / WebDAV / Google / Dropbox / OneDrive
│   │   ├── backup.js              # 备份编排、导出、定时器
│   │   ├── sync.js                # storage.sync 端到端同步：分片、AES-GCM、配对码
│   │   └── qr.js                  # 二维码渲染/解码封装
│   ├── vendor/                    # jsqr.js (Apache-2.0)、qrcode.js (MIT) + LICENSES.md
│   ├── popup/                     # 主界面（列表 / 添加 / 导入 / 解锁）
│   ├── options/                   # 设置页（加密 / 渠道 / 计划 / 恢复）
│   ├── content/autofill.js        # 登录页自动填充（Shadow DOM）
│   └── icons/
├── test/
│   ├── run.mjs                    # 算法 + 加密 + 保管库 + 备份（29 项）
│   ├── providers.mjs              # WebDAV + 三家 OAuth 的网络层（16 项，WebDAV 用真服务器）
│   ├── s3.mjs                     # S3 签名与对象存储全流程（15 项，含 botocore 逐字节比对）
│   ├── sync.mjs                   # 端到端同步：配额/分片/双设备/篡改（13 项）
│   ├── qr.mjs                     # 二维码编解码 + Python 交叉验证（9 项）
│   └── ui.mjs                     # jsdom 里的端到端 UI 测试（16 组断言）
├── build.mjs                      # 打包三个目标到 release/ + 校验 manifest 引用
├── release/                       # 构建产物：chromium / edge / firefox + 三个 zip
└── preview.html                   # 界面预览（无需安装即可查看设计）
```

### 常用开发命令

```bash
npm run build                          # 重新打包，并校验 manifest 引用的文件是否都存在
npm test                               # 29 内核 + 16 渠道 + 13 同步 + 9 二维码 + 15 S3 = 82 项
npm run test:ui                        # DOM 端到端冒烟测试
npx web-ext lint --source-dir release/firefox   # 目前 0 error / 0 warning
```

改完代码后浏览器里点扩展卡片上的「重新加载」即可生效。

测试覆盖了什么（都是能跑的真代码，不是 mock 逻辑）：

- **算法**：RFC 6238 的 SHA1/SHA256/SHA512 官方 8 位向量、RFC 4226 的 HOTP 前 6 个计数器、Base32 容错
- **加密**：信封加解密、错误密码拒绝、密文里搜不到明文密钥、换 IV、会话密钥复用
- **保管库**：首次创建、去重合并、增删改、开启主密码后落盘即密文、锁定/解锁、空闲自动锁定、快照裁剪与回滚、恢复覆盖
- **S3**：4 组预签名 URL 与 Python `botocore` 的输出**逐字节一致**（AWS 基础路径、R2 风格端点 + 非 ASCII 键名、带端口的 MinIO、EU 区域）；再起一个**独立重建 SigV4 验签**的 Node 服务器跑通 PUT/GET/恢复，错误 SecretKey 得到 403；文件夹模式验证 data URL 写入、目录路径自动补文件名、恢复时的提示文案
- **渠道**：WebDAV 用真实 HTTP 服务器验证 MKCOL/PUT/GET 与 Basic 认证；Google Drive 校验 multipart 创建与 PATCH 更新两条路径；Dropbox 校验 `Dropbox-API-Arg`；OneDrive 校验 App Folder 路径；错误状态写入
- **同步**：给假的 `storage.sync` 加上和 Chrome 一模一样的配额（单项 8 KB / 总量 100 KB / 512 项），验证分片写入、密文不含明文、两台「设备」配对往返、配对码错误回滚、分片篡改被拦、多分片清理、超配额报错、幂等推送与回声抑制
- **二维码**：编码→解码往返（otpauth / 迁移包 / passkey / 配对码四种载荷，含 2px 低分辨率与 H 级纠错），并与 Python `qrcode` 库生成的图做**独立实现交叉验证**；还校验 `toCanvas` 的绘制结果与模块矩阵一致
- **UI**：在 jsdom 里启动真实 background.js + 真实弹窗/设置页，7 个渠道标签与「免注册/需注册」标注、WebDAV 预设一键填地址、S3 面板字段齐全，再完成「加账户 → 显示正确验证码 → 搜索 → 开加密 → 锁屏 → 错误密码 → 正确密码解锁 → 域名匹配填充 → 建 Passkey → 详情页 → 扫码载荷分派 → 启用同步并生成配对码」全流程

---

## 八、常见问题

**为什么别的扩展点一下就能连 OneDrive，我这里没有那个按钮？**
那个授权弹窗（例如抬头写着 Authenticator Backup / authenticator.cc 的那一个）是**那家开发者自己在 Azure 注册的应用**。OAuth 客户端必须由「发布者身份」注册，一个第三方扩展不能替别的扩展注册，也不能内置别人的 Client ID —— 所以我们不提供「一键连 OneDrive」。想连 OneDrive 又不想碰 OAuth，就用 **2.1 文件夹同步**：把浏览器的下载目录指到 OneDrive 的本地文件夹，备份文件会被桌面客户端自动带走，全程没有授权弹窗。

> 顺带说一句：如果你看到别人的扩展弹出「对应用程序的文件夹具有完全访问权限 + 读取你的个人资料」，那是它注册的应用在向你的网盘要权限。其中「读取个人资料」是 Microsoft Graph 的 `User.Read` 默认项；文件夹权限若是 App Folder（`Files.ReadWrite.AppFolder`），它只能看到自己那个应用文件夹。授权随时可以在 https://microsoft.com/consent 撤销。

**只想备份、完全不想注册任何东西**
用「文件夹同步」：什么都不用填，备份直接落到下载目录，靠系统里的网盘客户端同步走（2.1）。想要更稳就用对象存储，生成一对 AccessKey/SecretKey 即可（2.2）。

**「测试连接」报 401/403**
WebDAV 用错密码最常见——坚果云必须是应用密码；群晖要注意端口和 HTTPS 证书。

**对象存储报 CORS / `Failed to fetch`**
桶没开跨域。按 2.2 里的 CORS 规则配置，允许 `GET` / `PUT` / `HEAD` 与 `*` 头。

**对象存储报 `SignatureDoesNotMatch`**
检查区域是否和服务端要求一致（R2 必须填 `auto`），以及 SecretKey 有没有多复制空格。

**Google 报 `invalid_client` / `redirect_uri_mismatch`**
回调地址没有逐字匹配（结尾斜杠、`http`/`https`）。注意每个浏览器的扩展 ID 不同，Firefox 的地址长得完全不一样。

**Firefox 上传失败**
先在 `about:addons` 给扩展授予「访问所有网站的数据」；再检查 WebDAV 地址是否 https。

**验证码和手机 App 不一致**
检查周期（默认 30 秒）与算法（默认 SHA1）；有的站点是 60 秒或 SHA256，在「高级选项」里改。

**扫码没识别出来**
截图里二维码别太小（每模块 ≥2 像素）、别有遮挡；价格标签式的彩色/反色码也能识别。实在不行直接粘贴 `otpauth://` 文本。

**两台设备同步了但看不到对方的数据**
先在旧设备点「立即推送」，再到新设备点「从云端拉取」。检查两台设备的配对码是否一致、系统时间是否接近（同步按时间戳判断新旧）。

**Passkey 存进去了，但网站登录还是要手机**
正常——见 3.2，扩展不能代答 WebAuthn。网站登录请继续用系统认证器。

**换电脑怎么迁移**
新设备装好扩展 → 设置页「从云端恢复」（或「从文件恢复」选导出的 json）→ 输入原主密码即可。

---

MIT License。自行承担保管密钥的责任；建议同时保留一份离线备份文件。

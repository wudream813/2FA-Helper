# 更新日志

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

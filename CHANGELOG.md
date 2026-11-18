# 更新日志

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

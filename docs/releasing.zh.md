# 发布

[English](releasing.md) | 中文

## 前置条件

- `dsh/` gitlink 已完成审查且工作区干净。
- 两套前端图、两套 Rust feature 套件、运行时闭包检查，以及真实的 dsh 集成测试均已通过。
- 插件载荷的平台和 target triple 必须与 bootstrap manifest 匹配；针对已挂载安装包的身份检查也必须再次通过。
- 每个目标都在对应的原生 CI runner 上构建。
- Bundled 和 Lite 产物使用相同的 DSH App 版本、dsh commit 和插件源。

未签名的开发产物使用：

```sh
node scripts/build-app.mjs --edition <bundled|lite> \
  --target <triple> --formal false
```

最终安装包只会发布到扁平的 `.build/installers/` 目录，并使用以下格式：

```text
dsh-app-<bundled|lite>-<version>-<macos|windows>-<arm64|x64>.<dmg|exe>
```

滚动 pre-release 构建会在扩展名前追加 `debug` 后缀和 7 位 commit hash：

```text
dsh-app-<bundled|lite>-<version>-<macos|windows>-<arm64|x64>_debug_<commit>.<dmg|exe>
```

该限定符通过 `--artifact-suffix debug --artifact-commit <commit>` 显式启用；两个参数必须同时提供。未提供时仍生成上述正式产物名称。

目标专用的 Tauri `release/bundle` 目录是临时目录，在完成安装包验证并发布后会被删除。应用标识和用户目录保持不变。
DMG 组装始终使用 CI 安全模式，确保打包期间不会因为 Finder 窗口或交互式本地桌面而持有临时读写镜像。

`.github/workflows/build-installers.yml` 会在每次 push 时运行六个原生目标/版本任务，以当前 GitHub commit 生成带 `_debug_<commit>` 限定符的文件，并且只从 `.build/installers/` 上传这些标准化文件。Push 构建不会签名。手动执行 `workflow_dispatch` 时，如果所有签名和公证密钥都可用，可以将 `formal: true` 打开。

## 正式 macOS 构建

除非已提供 Developer ID 签名变量和一套完整的公证凭据，否则 `--formal true` 会拒绝运行。Tauri 使用标准的 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`，以及 Apple ID 或 App Store Connect API 变量。

## 正式 Windows 构建

将 Authenticode 证书导入当前用户的证书存储区，将 `build/windows-signing.example.json` 复制到仓库之外，并填写证书 thumbprint 和签发者时间戳服务。然后运行：

```powershell
node scripts/build-app.mjs `
  --edition bundled `
  --target x86_64-pc-windows-msvc `
  --formal true `
  --signing-config C:\secure\windows-signing.json
```

也可以提供 Azure Artifact Signing 的 `signCommand` 覆盖配置。正式 Windows 构建在开始前会检查该覆盖配置：它必须包含完整的证书/时间戳配置，或包含带有 Tauri `%1` 文件占位符的 `signCommand`。示例配置中的占位值会被拒绝。

## 运行时溯源

Bundled 的 Node 只从 `https://nodejs.org/dist` 下载，并根据 `SHASUMS256.txt` 中的精确条目校验，同时将归档 SHA-256 记录在 `runtime-manifest.json` 中。DSH App 的 AGPLv3 许可证、Node 和 dsh 的许可证，以及生产环境 npm notices 都会打包到 `licenses/` 下。

`dsh-app-runtime` 插件从发布仓库的 `dsh` 子模块声明推导 Git remote。进入 App Runtime 时会清除过期的发现状态；只有显式的检查操作才会查询选中的 Stable Tag 或 Latest 默认分支渠道，只有确认操作才会获取并编译刚刚检查过的精确 ref。它不会更新 DSH App 自身，也不会移动子模块基线。

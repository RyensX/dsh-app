# DSH App

**中文** | [English](docs/README_EN.md)

DSH App 是 [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端， 基于Tauri2开发。

目标是为dsh提供稳定且易用的客户端环境，除了壳本身，其他功能都是基于标准DSH开发，不会修改dsh，100%兼容，还可自由更新dsh源码跟进官方更新。

目前支持macOS arm64/x64 和 Windows x64，提供两个打包类型版本：

- **Bundled**：开箱即用，包含固定版本的官方 Node 发行版，以及基于子模块提交构建的生产环境 dsh 运行时（也支持自由更新）。
- **Lite**：体积小，不包含 Node 和 dsh。它会优先使用兼容的系统 Node；若不可用，则下载同一固定版本的官方 Node；启动时会自动拉取dsh源码编译。

两个版本共用应用标识符、用户数据、托管的 dsh 更新和内置应用插件，可自由覆盖安装。

项目隔一段时间会发布release，希望随时体验新改进也可打开每次push的CI下载自动构建的包。

macOS 用户首次启动前请阅读 [macOS 首次启动授权指南](docs/macos-installation.zh.md)。

## 功能

- **桌面化运行**：自动启动并管理本地 dsh，支持 macOS 和 Windows。
- **双版本选择**：Bundled 开箱即用；Lite 体积更小，可复用系统 Node和直接使用dsh线上源码。
- **dsh 运行时更新**：支持稳定版与最新版通道，可在 App 内检查、安装、重启生效或还原（在设置里**App运行时**中使用）。
- **数据统一保存**：配置、凭据、会话与工作区都放在非程序目录下，覆盖安装和卸载都不会丢失数据。
- **精选内置插件**：内置精选 dsh 插件，增强功能与使用体验。

## 开发

```sh
git submodule update --init --recursive
corepack pnpm@11.7.0 install --frozen-lockfile
pnpm dev:bundled
pnpm dev:lite
```

请在对应的原生运行器上构建未签名安装包：

```sh
node scripts/build-app.mjs \
  --edition bundled \
  --target aarch64-apple-darwin \
  --formal false
```

支持的目标三元组为 `aarch64-apple-darwin`、`x86_64-apple-darwin` 和 `x86_64-pc-windows-msvc`。最终安装包统一输出到 `.build/installers/`，命名为 `dsh-app-<bundled|lite>-<版本>-<平台>-<架构>.<dmg|exe>`；Tauri 的 `target/.../bundle/` 仅作为构建临时目录。GitHub Actions 会在每次 push 时为所有原生目标和 edition 自动打包。

## 验证

```sh
pnpm check
node scripts/verify-resources.mjs
pnpm test:integration
pnpm test:integration:managed
```

解包应用程序包后：

```sh
node scripts/verify-artifact.mjs --edition bundled --path /path/to/app
node scripts/verify-artifact.mjs --edition lite --path /path/to/app
```

Lite 验证器会拒绝任何 Node 可执行文件和 dsh 运行时；Bundled 验证器要求两者都存在，并检查内嵌提交是否与子模块基线一致。

## 用户目录

macOS:   ~/.dsh-app/
Windows: %USERPROFILE%\.dsh-app\

```text

.dsh-app/
├── profile/                              # DSH_HOME
├── workspace/                            # dsh 初始工作目录
├── logs/dsh.log                          # 10 MiB，保留五份备份
├── config.json                           # 应用偏好设置，包括运行时通道
├── app-update.json                       # App Release 检查缓存和已忽略版本
├── updates/<release>/                    # 已下载、等待用户打开的 App 安装包
├── window-state.json                     # 记忆的窗口大小和位置
├── lite.json                             # 可选的显式 Lite Node 路径
└── runtime/
    ├── dsh/
    │   ├── source/                       # 持久化 Git 工作区
    │   ├── cache/                        # 可复用的包管理器缓存
    │   ├── staging/                      # 仅用于待发布的生产运行时
    │   └── installs/                     # 已发布的托管运行时
    ├── node/<version>/<platform>-<arch>/ # Lite 托管的备用 Node
    ├── control/
    ├── pending-action.json
    └── plugins.patch.json
```

配置、凭据、会话、生成的补丁和工作区绝不会写入应用程序包。删除托管 dsh 不会删除用户数据。

## 友链

[LinuxDo](https://linux.do/)

[dsh-market](https://github.com/dsh-market/dsh-market)

[dsh-message-fold](https://github.com/RyensX/dsh-message-fold)

[dsh-message-navigation](https://github.com/RyensX/dsh-message-navigation)

[dsh-resize](https://github.com/RyensX/dsh-resize)

[dsh-remote-gateway](https://github.com/RyensX/dsh-remote-gateway)


## 许可证

[GNU Affero General Public License version 3](LICENSE)

# 架构

[English](architecture.md) | 中文

## 发布基线

`scripts/prepare-resources.mjs` 会读取干净的 `dsh/` 子模块的精确 commit、匹配的 tag、CLI 版本、Node engine、锁定的包管理器版本，以及 `.gitmodules` 声明的子模块 URL。它会为两个版本生成签名的 `bootstrap-manifest.json`。除了该子模块声明之外，不会单独硬编码运行时源码 URL。

Bundled 还会创建一个分离的本地 clone，构建上游代码，部署生产闭包，删除源码和临时元数据，注入选定的 App 插件，并打包 `dsh-runtime/`。Lite 不会打包 dsh 文件。两个版本都会打包目标所选的插件载荷、一个小型 Corepack runner，以及自包含的源码运行时管理器。

插件载荷 schema v2 将构建选择使用的 `platform`（`macos` 或 `windows`）与运行时身份使用的 `targetTriple` 分开。资源和产物验证要求载荷的版本、target triple、platform、digest 和插件索引都与 `bootstrap-manifest.json` 匹配；因此不匹配的载荷会在构建阶段失败，而不是等到已安装 App 下次启动时才失败。

固定基线保持一致：

```text
dsh submodule gitlink
        ├── Bundled embedded runtime
        └── Lite bootstrap commit
```

## Node 提供方

Cargo features `bundled` 和 `lite` 互斥。

- Bundled 只解析自身的 Tauri Node sidecar。
- Lite 依次检查显式的 `lite.json`、继承的 `PATH`、常见安装目录，以及 `~/.dsh-app/runtime/node/<version>/<platform>-<arch>/`。如果不存在兼容候选项，就下载固定版本的官方 Node 归档，并校验发布构建时记录的 SHA-256。

系统发现、选择器、下载错误和 Lite 配置解析器都不会被编译进 Bundled。

## 通用 dsh 解析器

在已知 Node identity 和 ABI 后，两个版本运行同一个 resolver：

1. 读取待处理的更新或恢复操作。
2. 校验 `runtime/dsh/` 下受管理的 current pointer。
3. 优先使用与目标和 Node ABI 匹配的已编译 managed runtime；Commit 和 Tag 是更新元数据，不参与启动兼容性检查。
4. 当 Bundled provider 提供 embedded runtime 时，使用该运行时。
5. 如果不存在有效候选项，则从 bootstrap manifest 记录的子模块仓库 Git-fetch 并构建固定 commit。

受管理的安装位于 `runtime/dsh/installs/` 下。它们编译后的 dsh 主体会保留；只有 App 所有的插件层可替换。当 App 升级携带不同的插件载荷时，启动过程会刷新这些小型本地插件包及其索引，然后继续使用相同的已编译 dsh runtime。插件 digest 变化不会触发 Git、pnpm 或上游重建。
`runtime/dsh/source/` 是持久化的 Git checkout：首次构建时初始化，后续构建会 fetch 并强制 checkout 精确的目标 commit。工作树以及被忽略的依赖/构建缓存会在成功和失败后继续保留。`runtime/dsh/staging/` 只包含待发布的生产运行时；发布以及 current/pending 指针更新都是原子的。启动时不会查询远程 tags，只有在必须组装固定基线时才需要 Git。
依赖下载使用有界并发和延长后的请求超时；包存储位于 `runtime/dsh/cache/` 下，因此重试可以从已校验的缓存内容继续，而不必重新开始冷下载。在调用上游脚本之前，打包的 Corepack 会在 `runtime/dsh/cache/pnpm-home/` 下创建固定版本的 pnpm shim，并将该目录放到 `PATH` 最前面，因此嵌套的 dsh 构建命令会使用同一个 pnpm `11.7.0` 工具链。部分上游包脚本会将嵌套 runner 写成 `npm`/`npx`；App 自有的 POSIX 和 Windows 兼容 shim 会将这些名称映射回固定版本的 pnpm（`npx` 映射为 `pnpm dlx`），而不是打包或调用 npm。

## 运行时更新

`dsh-app-runtime` 提供 dsh 设置区块和 Host Remote 服务。浏览器通过 dsh 受信任的 `/api` 连接调用该服务，不经过 Tauri IPC。进入 **App Runtime** 区块时会清除之前的发现结果，不会联系上游。只有显式的检查操作才会运行 `git ls-remote`。持久化的 **Stable** 渠道会对上游 `dsh-v*` Tags 排序，并选择最新 Tag 的 commit；**Latest** 会通过符号化的 `HEAD` 解析远程默认分支，并选择该分支的最新 commit。发现结果只保留在客户端内存中，不会获取源码 checkout；是否有更新只由精确的 commit identity 决定。

确认后的更新会将选中的 Tag 或分支及其检查过的 commit 传给管理器。Git 会将该 ref fetch 到隔离的 staging 中，验证它仍然解析到已检查的 commit，然后才会在运行中进程旁边编译，并创建 `runtime/pending-action.json`。当前进程会继续运行，直到用户选择 **Restart now**，或稍后重启 App。Host 会写入一次性控制请求，并请求 `ctx.appExit` 优雅退出。随后 Tauri 会重新启动整个桌面进程，使 WebView 从本地 bootstrap 内容开始，而不会在已停止的 loopback 页面上竞争两次导航。新进程会启动待处理候选项，只有在就绪后才提交它；如果启动失败，之前的运行时仍会保留。

只有当运行中的 commit 与 App 基线不同时，两个版本才会显示恢复选项。Bundled 会切换到 embedded runtime。Lite 会通过同一个精确 ref Git builder 准备基线 commit，然后在重启边界切换。就绪后，Bundled 会删除所有外部 dsh 数据；Lite 只保留当前活动的基线安装，并删除 checkout、缓存、staging 和其他安装。Profile、session 以及其他用户数据不会受影响。

当发现有更新的 commit 时，设置页面还会提供本地化的摘要操作。该操作会将 repository/compare prompt 写入当前对话草稿并关闭 Settings；它不会自行提交 prompt。该区块还负责固定的命令行启动器操作：它会创建一个绑定当前 Node、dsh entry 和 `DSH_HOME` 的私有 wrapper，打开平台终端，并且不接受浏览器提供的命令或路径。

## 启动与信任边界

dsh 会按以下方式启动：

```text
node dsh-runtime/lib/bin.js \
  --profile web \
  --patch ~/.dsh-app/runtime/plugins.patch.json \
  --port 0 \
  --no-open
```

子进程继承正常环境，而 DSH App 会覆盖 `DSH_HOME`，设置经过校验的 spawn-helper 和 runtime-manager 信息，并移除 `NODE_OPTIONS` 和 `NODE_PATH`。只有精确匹配 `dsh web: http://127.0.0.1:<port>` 的就绪行才会被接受。

只有本地 bootstrap 页面会获得版本专用的 Tauri capabilities。dsh loopback origin 不会获得任何 capability。HTTPS 链接会在系统浏览器中打开；其他意外导航都会被拒绝。Unix process group 和 Windows Job Object 会使 dsh、更新构建及其子进程受 App 生命周期约束。

bootstrap 失败页面可以打开由运行中 App 的 `UserDirs` 解析出的同一个跨平台数据根目录。浏览器不会提供路径，因此该功能不能选择任意文件系统位置。

桌面 shell 只恢复和保存主窗口的大小与位置。状态保存在 `~/.dsh-app/window-state.json` 中；最大化、全屏、可见性和装饰状态都被有意排除。

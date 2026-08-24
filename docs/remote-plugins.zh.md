# 远程插件清单

[English](remote-plugins.md) | 中文

仓库根目录的 `remote-plugins.json` 声明由 DSH App 远程安装的第三方 dsh
bundle。该文件只包含元数据：插件包不会复制进 App 资源，也不会 patch 到已经编译的
dsh runtime 中。

App 内置插件继续放在 `plugins/` 下，并沿用受信任的 `plugins.patch.json` 链路。
远程插件则通过 dsh 官方的 `dsh plugin --profile web add ...` 命令，安装到
`~/.dsh-app/profile/profiles/web/` 下的持久化 `web` profile。

## 配置格式

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "name": "turtle-ui",
      "source": "github:deepseek-harness/turtle-ui#0123456789abcdef0123456789abcdef01234567",
      "policy": "default",
      "allowBuild": true,
      "targets": ["macos", "windows"],
      "editions": ["bundled", "lite"]
    },
    {
      "name": "@vendor/dsh-example",
      "source": "@vendor/dsh-example@1.2.3",
      "policy": "required",
      "targets": ["macos"]
    }
  ]
}
```

构建阶段会校验根目录清单，并且只把匹配当前 target 和 edition 的条目写入安装包内的
`resources/remote-plugins.json`。

## 字段说明

| 字段 | 必填 | 含义 |
|---|---:|---|
| `schemaVersion` | 是 | 清单格式版本，当前固定为 `1`。 |
| `plugins` | 是 | 有序的远程插件声明；包名不能重复。 |
| `name` | 是 | 安装后预期的 `package.json.name`，也用于校验和所有权状态。 |
| `source` | 是 | 作为单个参数传给 `dsh plugin ... add` 的 pnpm source，规则见下文。 |
| `policy` | 是 | 只能是 `default` 或 `required`。 |
| `allowBuild` | 否 | 默认为 `false`；设为 `true` 时，安装前会把包名加入 profile 的 pnpm `allowBuilds` 映射。 |
| `targets` | 是 | `macos`、`windows` 中的一个或两个。 |
| `editions` | 否 | `bundled`、`lite` 的任意组合；省略表示两者都支持。 |

`default` 插件会自动安装，但安装失败不会阻止 dsh 启动。失败原因会写入 DSH App
日志，并在之后的启动中重试。

`required` 插件必须在 dsh 启动前完成安装和校验。缺失、冲突或无效的必需插件会
终止本次启动，并显示可重试的启动错误。

## Source 规则

支持三种 source：

- npm 裸包名：`dshmarket` 或 `@vendor/dsh-example`。
- npm 精确版本：`@vendor/dsh-example@1.2.3` 或 `dsh-example@1.2.3`。
- GitHub pnpm spec：`github:owner/repository`，可以追加 `#ref`。

npm 裸包名会跟随 registry 当前的默认版本；如果 App 版本需要稳定复现同一个插件包，
应使用精确版本。

正式发布时建议把 GitHub source 固定到完整 commit SHA：

```json
"source": "github:owner/repository#0123456789abcdef0123456789abcdef01234567"
```

GitHub 安装会在安装期间把仓库源码下载到用户的 pnpm store 和 profile，但不会把源码
加入 DSH App 安装包。已发布的 npm 包可以避免 Git checkout 和源码构建，但最终安装
哪些文件仍取决于发布者的 package 文件清单。

Git 托管的 TypeScript 包通常通过 `prepare` 构建。pnpm 会阻止未经授权的生命周期
脚本。只有在审查并信任固定后的源码时才能设置 `allowBuild: true`；这代表允许该包在
安装期间、agent 沙箱之外执行代码。

## 插件契约与所有权

每个远程包都必须是 dsh profile bundle，其安装后的 manifest 必须声明真实存在的
patch 文件：

```json
{
  "name": "dsh-example",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

dsh 完成安装后，DSH App 会校验包名、bundle patch、profile dependency 和
`dsh.profile.bundles` 激活状态；全部通过后，才会把它记录为 App 管理的插件，状态保存
在 `~/.dsh-app/runtime/remote-plugins.state.json`。

如果用户已经从其他 source 安装了同名依赖，App 不会静默覆盖，而是报告冲突。
在 schema version 1 中，从清单删除条目不会自动卸载已经安装的包。

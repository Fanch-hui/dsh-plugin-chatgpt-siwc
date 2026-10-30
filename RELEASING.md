# 发布指南

本文面向 `dsh-plugin-chatgpt-siwc` 的维护者。公开源码仓库为 [dsh-plugin-chatgpt-siwc](https://github.com/Fanch-hui/dsh-plugin-chatgpt-siwc)，npm 为公共分发渠道，当前版本为 `0.9.6`。用户在 DSH 插件管理页面输入包名安装；最低宿主版本为 `0.2.1-rc.3`，后续版本按实际接口变化适配。

## 发布前确认

- 核对 [package.json](<package.json>) 中的版本、包名、许可、公开源码元数据、DSH 兼容声明与文件白名单，以及目标公开仓库的管理权限。
- 核查准备公开的源码、文档和构建产物中的凭据、账号信息、个人路径、日志、诊断文件及本机配置。发现凭据泄漏时先撤销或轮换，再清理受影响内容。
- 对外源码采用下文的独立公开快照机制。本机开发历史继续留在本机；公开快照的历史和作者身份按发布机制单独维护。
- 完成类型检查、测试、发布审计与必要桌面手动验收，核对 [README.md](<README.md>) 的版本说明和 [PRIVACY.md](<PRIVACY.md>) 的数据边界。
- 首次 npm 上传前获得用户对包名、版本、公开内容与上传动作的明确确认。源码上传也应在已确认的目标与范围内执行。
- npm 注册表维护者元数据可能公开发布用户名和联系邮箱。发布账号应使用已确认可公开的身份与联系邮箱，认证信息始终保留在本机。

`check:release` 检查当前仓库文件及构建包；公开快照决定对外 Git 历史的范围。两者应一起使用。

## 本地验证

使用 Node.js 22 或以上，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run check:release
```

`check:release` 构建插件、检查 npm 包文件清单，并审计当前仓库文件及打包内容中的隐私信息。检查失败时先修复。OAuth 测试使用人工构造数据及临时回环监听，验证过程不读取真实凭据。

0.9.2 的桌面验收包括账号切回与退出重登的回放隔离、原生回放 v3 的空内容块与编辑顺序、网络中断及长连接轮换、诊断跨重启比较和 JSON/CSV 复制。HMAC 密钥与比较基线的 24 小时边界详见 [PRIVACY.md](<PRIVACY.md>)。

## 公开源码快照

源码仓库的发布工具路径为 `scripts/prepare-public.mjs`。工具从干净且已提交的本机 `HEAD` 读取当前 tree，并在审计通过后准备独立公开提交：

- 首次公开提交没有父节点；后续提交只以公开仓库的 `main` 为父节点。相同 tree 可复用现有公开提交。
- 公开提交使用项目通用作者和提交者身份，本机开发 `HEAD`、分支和旧历史保持原位。
- 本机准备结果保存到 `refs/dsh-public/prepared`；工具只向公开 `main` 及本次指定的版本标签写入。
- 未提交改动会阻止准备或上传。公开仓库地址来自已提交的 [package.json](<package.json>)，以 HTTPS GitHub 地址为准。

| 命令 | 验证与行为 |
| --- | --- |
| `npm run prepare:public` | 构建、内部发布审计，准备快照，不上传；会读取远程公开 `main` 以确定父节点 |
| `npm run publish:source` | 构建、内部发布审计，准备并上传公开 `main`，不创建版本标签 |
| `npm run release:source` | 类型检查、测试、构建、内部发布审计，原子上传公开 `main` 与当前版本的 `vX.Y.Z` 标签 |

先按项目流程提交审查通过的本地改动，确认工作树干净，再执行上述命令。公开快照中的内容就是该本地提交的完整 tree，生成的构建包另经发布清单审计。

## 首次公开源码与创建 npm 包

首次 npm 包创建、注册账号和登录均由维护者自己完成。使用浏览器注册 npm 账号，完成平台要求的账号验证与安全设置；认证信息保留在维护者本机。

1. 完成本地验证，核对已提交的 [package.json](<package.json>) 中 `repository`、`homepage` 和 `bugs` 对应真实公开仓库。
2. 在已授权范围内先上传公开源码：

   ```sh
   npm run publish:source
   ```

   此时只更新公开 `main`。首次 npm 包和 trusted publisher 尚未配置时，使用这一入口发布源码。
3. 核对公开源码内容，检查 npm 包名可用性与维护账号权限；获得首次 npm 上传确认后，在维护者本机执行：

   ```sh
   npm login
   npm publish --access public
   ```

4. 在 npm 核对包版本、公开内容和安装入口，再配置下方 trusted publishing。

首次手动发布已占用的版本不再重复发布。自动发布从递增后的下一个稳定版本开始。

## 配置 trusted publishing

### GitHub environment

在公开仓库创建名为 `npm` 的 environment，设置发布审批人并启用 required reviewers。维护者先确认当前仓库方案支持这些环境保护规则，再启用自动发布。审批人核对本次标签、测试结果和待发布工件后批准。

### npm trusted publisher

在已有 npm 包的设置中新增 GitHub Actions trusted publisher，准确绑定：

| 字段 | 值 |
| --- | --- |
| Organization or user | 公开仓库的 owner |
| Repository | `dsh-plugin-chatgpt-siwc` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

源码仓库的工作流路径为 `.github/workflows/release.yml`。owner 与 repository 应和上述公开源码地址一致；迁移或更名后同步更新。

自动发布使用 GitHub-hosted runner 和 npm CLI `>=11.5.1`。发布 job 通过 `id-token: write` 获取 OIDC 身份，npm 根据上述绑定授予发布权限，无需长期 npm 发布 token。

### 标签与工件

工作流仅在公开 GitHub 仓库执行发布，从 `GITHUB_REPOSITORY` 自动写入发布包的 `repository`、`homepage` 和 `bugs` 元数据，用于 npm provenance。只发布稳定版 `vX.Y.Z`，标签去掉 `v` 后必须与 [package.json](<package.json>) 的 `version` 完全一致，npm 分发标签为 `latest`。

1. 验证阶段检出标签对应的公开提交，安装依赖，执行类型检查、测试、`check:release` 和标签复核，再打包上传 `.tgz` 工件。
2. 发布 job 受 `npm` environment 审批保护，获批后下载该工件，通过 OIDC 发布同一份 `.tgz`，不重新构建。

## 后续版本发布

1. 准备、审查本次变更并完成必要桌面验收。需要补丁版本时，在本机开发分支执行：

   ```sh
   npm version patch --no-git-tag-version
   ```

2. 检查版本与文档，按项目流程提交所有审查通过的本地改动，保持工作树干净。版本提交留在本机开发历史，公开提交由快照工具另行生成。
3. 确认首次 npm 包、trusted publisher 和 environment 审批配置均已完成，再执行：

   ```sh
   npm run release:source
   ```

4. 工具执行验证并原子上传公开 `main` 和本版本标签。GitHub Actions 根据标签运行，审批人核对结果及工件后批准 npm 发布。
5. 在 npm 确认版本与 `latest` 指向，按 [README.md](<README.md>) 在目标 DSH 手动验证安装及更新。

需要 minor 或 major 版本时，选择相应的 `npm version` 参数并保留 `--no-git-tag-version`，继续使用同一套快照、标签和审批流程。只同步源码时使用 `npm run publish:source`。

## 发布失败处理

- 工作树未提交或审计失败：先完成审查、修复和本地提交，再重新准备快照。
- 公开分支已更新或原子推送失败：核对目标仓库状态后重跑快照流程，由最新公开 `main` 生成父节点。
- OIDC 或权限失败：核对 npm trusted publisher 的 owner/repository、`release.yml`、environment `npm`，以及 runner、npm CLI 版本和 job 权限。
- npm 版本已存在：先核实该版本状态；内容变化时递增版本，重新验证并发布。
- 发布后发现问题：通过修复版本交付；需要调整 `latest` 或撤回分发时，由维护者确认影响范围后操作。

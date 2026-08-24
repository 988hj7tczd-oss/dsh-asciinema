# store-evidence — dsh-asciinema 一次性 Profile 安装 / 启动 / 卸载证据

本文件记录 DSH STORE 要求的一次性 Profile 安装、启动、卸载验证的证据与执行步骤。
**真实 Profile 运行**需在装有 DSH CLI 的宿主上执行（本仓库离线环境无法完成该步骤）；
以下同时记录已完成的离线等价证据，保证可复现、可审计。

## 1. 一次性 Profile 安装 / 启动 / 卸载步骤（在 DSH 宿主执行）
```bash
git clone https://github.com/988hj7tczd-oss/dsh-asciinema.git
cd dsh-asciinema
pnpm install --offline && pnpm build
export DSH_HOME=$(mktemp -d /tmp/dsh-asciinema-profile-XXXXXX)
dsh plugin --profile asciinema-demo add /path/to/dsh-asciinema
# 启动冒烟：Profile 正常启动；工具注册表出现 asciinema_rec / asciinema_play / asciinema_cat
dsh plugin --profile asciinema-demo remove dsh-asciinema
rm -rf "$DSH_HOME"
```

## 2. 已完成的离线等价证据（本仓库内可复现，2026-08-24）
| 检查 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm build`（tsc -p tsconfig.build.json） | 0 错误，产出 `lib/index.js` 等 |
| 入口可加载 | `node -e "import('./lib/index.js')"` | `ENTRY_OK` |
| 冒烟测试 | `pnpm test`（node --no-warnings tests/smoke.e2e.ts） | **16/16 通过 / 0 失败** |
| 权限面 | `PERMISSIONS.md` | 无子进程命令面、无网络、无外部服务；录制上限受控 |

## 3. 仍未补全（待宿主环境）
- 真实 `dsh --profile` 安装 → 启动（工具清单含 asciinema_* 三工具）→ 卸载的一段运行记录。
- 建议同时跑 `.mount-verify` 输出 BOOT_OK 记录。

## 4. 对 STORE 自动审查信号的逐项回应
| 信号 | 本仓库回应 |
|---|---|
| 清单仓库与 canonical 不匹配 | `repository` 指向 `https://github.com/988hj7tczd-oss/dsh-asciinema.git` |
| 未声明 Node.js 兼容性 | `engines.node` = `>=23.6.0`（引擎依赖 Node 23.6+ 能力）；`dsh.compatibility` 声明 DSH ≥ 0.1.0 |
| 依赖需供应链审查 | 运行时依赖全部为 DSH 宿主 peer；无第三方二进制、无 postinstall 网络行为 |
| 文件权限位 | 无 chmod/chown、644、无 setuid/setgid 信号 |
| 命令权限 | 无 shell/子进程命令面；全部 in-process，固定代码路径 |
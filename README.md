# dsh-asciinema

> [!IMPORTANT]
> **依赖前置：相邻 `dsh-src` 检出（`link:` 依赖）**
> 本项目在开发形态下使用 `link:` 依赖指向相邻的 DeepSeek Harness 源码检出（`dsh-src`），
> 与当前仓库保持同一父目录布局（`<parent>/dsh-src`）。克隆本仓库后：
> 1. 先把官方 `deepseek-ai/deepseek-harness` 检出到与本仓库同级的 `dsh-src/` 目录，并执行其 `pnpm install && pnpm run build`；
> 2. 再按下方「安装」一节执行本仓库的 `pnpm install --offline && pnpm build` 与测试。
> 发布到 npm 的版本会尽量把 `link:` 依赖替换为 registry 真实版本；无法替换的内部包保持 `link:`，见各包 README 说明。


DSH 插件:把会话中的终端/工具输出录制为 **asciinema v2（`.cast`）** 文件,提供内嵌播放器
（**自带离线渲染器**,标签结构对齐 asciinema-player 数据模型）回放与 HTML 导出。

- 语义对齐官方 asciinema CLI 三动作:**rec（录制）/ play（回放）/ cat（转文本）**。
- 录制来源低侵入:订阅 `session/event` 事件流中的 `tool/result` 输出(无需依赖 terminals 服务)。
- 独立实现 cast-core,不依赖 asciinema CLI;播放器数据内嵌,**完全离线渲染,无外部请求**。
  (未与官方 asciinema play/player 做互操作验证 —— ".cast 可被官方工具解析"不在本交付宣称内)

## 交付物结构

```
dsh-asciinema/
├── cordis.yml            # bundle patch:插入一行插件(可配)
├── package.json          # dsh.bundle 声明 + peerDependencies + engines.node
├── tsconfig.json         # 静态检查(noEmit,路径映射指向同级 dsh-src)
├── tsconfig.build.json   # 构建配置:src → lib/(ESM + .d.ts)
├── LICENSE               # MIT
├── NOTICE                # 第三方声明(MPL-2.0 player 资产/NOTICE)
├── src/
│   ├── index.ts          # 装配:注册 3 工具 + 会话录制器 + 会话结束策略
│   ├── cast-core.ts      # v2 格式核心:writer/reader/尺寸/时间轴/ANSI(零依赖)
│   ├── recorder.ts       # 订阅 tool/result → 事件缓冲;SessionRecorder / RecorderRegistry
│   ├── cast-io.ts        # 读写 .cast/.html、播放器模板加载
│   └── tools/
│       ├── rec.ts        # term_rec:start/stop/mark/status(按会话隔离)
│       ├── play.ts       # term_play:离线 HTML 回放或文本化
│       └── cat.ts        # term_cat:cast → 纯文本
├── assets/
│   └── player.html       # 自带离线渲染器模板(无 <asciinema-player> 标签,支持 ?url= 加载)
├── lib/                  # pnpm build 产物(main/types 指向此,源码形态下不预置)
└── tests/
    ├── smoke.e2e.ts      # 离线单元级冒烟(纯逻辑,未挂载 DSH 运行时;16 项)
    └── node-ambient.d.ts
```

## 安装与加载

> **交付形态说明 — 当前为源码形态**:`package.json` 的 `main/types` 指向 `lib/`(编译产物),
> 但仓库不预置 `lib/`。**正式挂载前必须先 `pnpm build`**;开发期可用绝对路径直载源码
> (见下文两种模式)。运行/加载 `.ts` 依赖 Node ≥23.6 内置 type 擦除;22.x 需
> `--experimental-strip-types` 启动标志(`engines.node` 已声明 `>=23.6.0`)。

作为 bundle 安装(仓库根目录),按环境选一种挂载模式:

**模式 A — dev:绝对路径行名直载源码**(免构建,开发期):

```sh
dsh plugin --profile demo add /abs/path/to/dsh-asciinema/src/index.ts
dsh --patch /abs/path/to/dsh-asciinema/cordis.yml   # 或本地叠加
```

**模式 B — 生产:编译入口/裸包名**(推荐正式环境):

```sh
cd dsh-asciinema && pnpm build          # 生成 lib/(ESM + .d.ts)
dsh plugin --profile demo add ./dsh-asciinema       # 解析 package.json main → lib/index.js
```

`cordis.yml` 的插入行:

```yaml
- insert:
    - id: asciinema
      name: dsh-asciinema
      config:
        width: 100          # 录制几何宽
        height: 40          # 录制几何高
        maxEvents: 5000     # 事件条数上限(超过封存)
        maxBytes: 1048576   # 数据字节上限(超过封存)
        recordInput: false  # 隐私默认:只录输出,不录输入
        castsDir: '.casts'  # 落盘目录(相对会话工作区)
```

> `playerUrl` 为**预留字段,未实现**:源码不消费该配置,配置了也不生效,故不在上述配置
> 清单中列出(历史版本曾出现,见「行为细节」)。

## 工具规格

### term_rec — 录制(rec 语义)

参数:`action('start'|'stop'|'mark'|'status')`、`name?`、`scope('session'|'command')`、
`record_input?`、`marker?`。

- `start`:订阅当前会话的 `tool/result` 输出,缓冲为 `[delay, 'o', data]`;`delay` 相对录制
  开始、单调不减。
- `stop`:同名再调用即停止,写 `<castsDir>/<name>.cast` 到会话工作区(version=2、
  width×height、`timestamp`、`env{SHELL,TERM}`、`title`),返回路径与事件数。
- `mark`:录制中插入 `'m'` 标记事件(可选命令,"标记此处")。
- `status`:列出活动录制。
- `scope=command`:当前 agent 步骤(`step/end`)结束自动封存,适合"这条命令的输出"。
- 录制边界:输入事件默认不录(隐私默认);`record_input=true` 才以 `'i'` 记录。

### term_play — 回放(play 语义)

参数:`path`(必填)、`mode('auto'|'html'|'text')`。

- 默认生成自包含离线 HTML(播放器模板 + cast 数据内嵌,无任何外部请求),写到
  `.cast` 同目录的 `.html`,返回可点击链接;`presentationMeta` 持久化回放卡片。
- `mode=text`:输出去除控制序列的纯文本(无浏览器环境兜底)。

### term_cat — 转文本(cat 语义)

参数:`path`(必填)、`raw?`、`include_input?`。

- 顺序拼接 `'o'` 事件,默认剥离 ANSI 控制序列;`raw=true` 保留 escape 序列原文
  (终端协议保真,播放时由播放器解释)。

## 行为细节

- **截断策略(验收标准 3)**:录制超过 `maxEvents`/`maxBytes` 时**封存**(seal),标记
  `truncated` 并在停止结果里提示;封存后不再吸收新事件。
- **会话结束(验收标准 4)**:命名录制自动保存,未命名(自动命名)录制自动丢弃并提示。
- **播放器资产**:`assets/player.html` 为**自带离线渲染器**(剥离 ANSI、行缓冲、播放/暂停、
  速度、seek、marker 展示、idle 快进),数据模型对齐 asciinema-player(内嵌 v2 cast;
  **无 `<asciinema-player>` 标签、无官方 player 依赖**),并可 `?url=xxx.cast` 直接加载
  外部文件。官方 asciinema-player(MPL-2.0)暂未随包;`playerUrl` 为**预留字段,未实现**,
  当前不提供官方 player 标签注入。分发时携带 `NOTICE`。

## 开发与测试

```sh
pnpm build        # 编译 src → lib/(ESM + .d.ts);正式挂载前执行
pnpm test         # 离线单元级冒烟:node --no-warnings tests/smoke.e2e.ts(16 项)
pnpm typecheck    # 静态类型检查(tsc,noEmit)
```

- 冒烟测试为**离线单元级冒烟(未挂载 DSH 运行时的纯逻辑覆盖)**:不构建 Cordis 上下文、
  不注册工具、不落盘。覆盖:writer 结构、单调时间轴、容量封存、容错解析、ANSI 剥离、
  recorder 事件接线(`tool/result`→`'o'`、输入隐私、`step/end` 命令边界)、注册表
  同会话冲突与**跨会话隔离**、播放器模板渲染(含 `</script>` 转义与内嵌 JS 语法校验)。
  限制:以自写 parser 自证 round-trip,**未与官方 asciinema play/player 做互操作验证**;
  播放器仅做模板/语法级校验,**未在浏览器/DOM 中执行播放流程**。
- 测试直接 `import` `.ts`,需 Node ≥23.6(内置 type 擦除;22.x 加
  `--experimental-strip-types`,见 `engines.node`)。
- 类型检查对照 `dsh-src` 各包的已编译声明,**前提:旁边有同级 `dsh-src` 检出**
  (tsconfig paths 用相对路径 `../../../dsh-src`,换目录布局需同步调整;`peerDependencies`
  由 DSH host 提供)。

## 格式参考

asciicast v2(https://docs.asciinema.org/manual/asciicast/v2/ ):
`version=2`;`events` 为 `[delay, type, data]` 三元组;`'o'`=输出、`'i'`=输入、
`'m'`=标记、`'r'`=尺寸调整(`"80x24"`);`delay` 为相对前一帧秒数,单调不减。
本项目的 cast-core 为独立实现,不依赖外部 CLI。

## 许可证

- 本项目代码:**MIT**(见 LICENSE)。
- 可选分发官方 asciinema-player 资产时遵循 **MPL-2.0** 并携带 NOTICE(见 NOTICE)。

## 权限、失败边界与 DSH STORE 状态

- [PERMISSIONS.md](./PERMISSIONS.md)：运行时读取面 / 命令面（固定 argv，非 shell）/ 写面 / 外部服务 / 失败边界 / 供应链 / 文件权限信号（无 chmod/chown、644、无 setuid/setgid）。
- [docs/store-evidence.md](./docs/store-evidence.md)：一次性 Profile 安装 → 启动（工具注册清单）→ 卸载步骤、本地离线证据、待宿主补录真实运行记录说明，并逐项回应 DSH STORE 五类审查信号（仓库 canonical 匹配 / Node 声明 / 供应链 / 文件权限 / 命令权限）。
- STORE 复检由 dsh-safe-plugin-manager 每 3 小时自动执行；本仓库已按清单契约声明（package.json 的 `repository` / `engines.node` / `dsh.compatibility` / `dsh.permissions`）。

/**
 * asciinema v2 (.cast) 格式核心:writer / reader / 时间轴 / 尺寸 / ANSI 清理。
 *
 * 这是本插件的“终端协议无关”纯事件流实现,独立于 asciinema CLI 自研,
 * 零运行时依赖、无副作用,可完全离线单测(见 tests/smoke.e2e.ts)。
 *
 * 格式参考:https://docs.asciinema.org/manual/asciicast/v2/
 *   version 必为 2;events 为 [delay, type, data] 三元组;
 *   "o"=输出,"i"=输入,"m"=标记(marker),"r"=尺寸调整(data 形如 "80x24");
 *   delay 为相对前一帧的秒数(首帧相对录制开始),单调不减。
 *
 * @module dsh-asciinema/cast-core
 */

/** asciicast v2 事件类型:'o' 输出、'i' 输入、'm' 标记、'r' 尺寸调整。 */
export type CastEventType = 'o' | 'i' | 'm' | 'r'

/** asciicast v2 事件三元组:[相对秒, 类型, 数据]。 */
export type CastEvent = [number, CastEventType, string]

/** 与官方 v2 一致的 header 元字段。 */
export interface CastMeta {
  width: number
  height: number
  /** Unix epoch 秒;writer 缺省时自动打当前时间。 */
  timestamp?: number
  title?: string
  /** 如 { SHELL: '/bin/bash', TERM: 'xterm-256color' }。 */
  env?: Record<string, string>
  /** 播放器把超过该秒数的帧间间隔视为空闲并快进。 */
  idle_time_limit?: number
  /** 被录制的命令(若有)。 */
  command?: string
}

/** 一个完整 asciicast v2 文件。 */
export interface CastFile extends CastMeta {
  version: 2
  events: CastEvent[]
}

export const CAST_VERSION = 2 as const
export const DEFAULT_WIDTH = 100
export const DEFAULT_HEIGHT = 40

/** 播放器/工具对几何尺寸的合理上限,防止脏数据撑爆渲染。 */
export const MAX_DIMENSION = 1000

/** 时间轴精度:毫秒 → 秒,保留 3 位小数(官方播放器即按 3 位小数处理)。 */
const SECOND_PRECISION = 1000

/** 单调时钟:优先 performance.now()(单调且与墙上时间无关),回退 Date.now()。 */
function monotonicMs(): number {
  // 在 DSH host(Node)与浏览器中都存在;这里做防御性探测保持纯函数可测。
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/** 把毫秒差折算为秒并保留 3 位小数。 */
export function roundDelay(ms: number): number {
  return Math.round((ms / SECOND_PRECISION) * SECOND_PRECISION) / SECOND_PRECISION
}

/** 生成 Unix epoch 秒(默认当前时间)。 */
export function castTimestamp(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000)
}

/** 环境快照:尽力读取,失败时回退常量(“env 视可用性”)。 */
export function defaultCastEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const SHELL = typeof process !== 'undefined' ? process.env['SHELL'] : undefined
  const TERM = typeof process !== 'undefined' ? process.env['TERM'] : undefined
  env['SHELL'] = SHELL !== undefined && SHELL !== '' ? SHELL : '/bin/sh'
  env['TERM'] = TERM !== undefined && TERM !== '' ? TERM : 'xterm-256color'
  return env
}

/** 把尺寸规整到合法区间 [1, MAX_DIMENSION],非法值回退默认。 */
export function sanitizeWidth(width: number | undefined): number {
  if (width === undefined) return DEFAULT_WIDTH
  if (!Number.isFinite(width)) return DEFAULT_WIDTH
  return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(width)))
}

export function sanitizeHeight(height: number | undefined): number {
  if (height === undefined) return DEFAULT_HEIGHT
  if (!Number.isFinite(height)) return DEFAULT_HEIGHT
  return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(height)))
}

/** writer 的容量护栏:超过任一上限即“封存”(seal),不再吸收新事件。 */
export interface CastWriterOptions {
  width?: number
  height?: number
  /** 事件条数上限(含所有类型),默认无上限。 */
  maxEvents?: number
  /** 缓冲数据 UTF-8 字节上限,默认无上限。 */
  maxBytes?: number
  /** 空闲时钟:帧间超过该秒数视为空闲(写入 header,播放器可据此快进)。 */
  idleTimeLimit?: number
  /** 被录制命令(写入 header)。 */
  command?: string
}

export interface CastWriterMeta {
  title?: string
  timestamp?: number
  env?: Record<string, string>
  idle_time_limit?: number
  command?: string
}

/**
 * 事件缓冲器:按 asciinema v2 语义计算 [delay, type, data]。
 * delay 单调不减、非负;首帧相对录制开始。
 */
export class CastWriter {
  private readonly events: CastEvent[] = []
  private readonly options: CastWriterOptions
  private readonly startMs: number
  private lastMs: number
  private lastDelay = 0
  private bytes = 0
  private sealed = false
  private truncationReason: 'events' | 'bytes' | undefined = undefined

  constructor(options: CastWriterOptions = {}) {
    const now = monotonicMs()
    this.startMs = now
    this.lastMs = now
    this.options = options
  }

  get width(): number {
    return sanitizeWidth(this.options.width)
  }

  get height(): number {
    return sanitizeHeight(this.options.height)
  }

  get eventCount(): number {
    return this.events.length
  }

  /** 已缓冲数据的 UTF-8 字节近似(TextEncoder 输出即为 UTF-8 长度)。 */
  get byteSize(): number {
    return this.bytes
  }

  /** 是否已到达记录起点(尚未 push 过任何事件)。 */
  get isEmpty(): boolean {
    return this.events.length === 0
  }

  /** 是否已封存(达到容量上限或手动 seal)。 */
  get isSealed(): boolean {
    return this.sealed
  }

  /** 封存是否由容量上限触发。 */
  get isTruncated(): boolean {
    return this.truncationReason !== undefined
  }

  /** 封存原因枚举。 */
  get truncationCause(): 'events' | 'bytes' | undefined {
    return this.truncationReason
  }

  /** 距录制开始的相对秒数(截至最后一次 push)。 */
  get elapsed(): number {
    return roundDelay(Math.max(0, this.lastMs - this.startMs))
  }

  /** 预检:封存后或任一容量上限将超限时拒绝。 */
  private canAccept(dataLength: number): boolean {
    if (this.sealed) return false
    const maxEvents = this.options.maxEvents
    const maxBytes = this.options.maxBytes
    if (maxEvents !== undefined && this.events.length >= maxEvents) {
      this.sealBy('events')
      return false
    }
    if (maxBytes !== undefined && this.bytes + dataLength > maxBytes) {
      this.sealBy('bytes')
      return false
    }
    return true
  }

  private sealBy(reason: 'events' | 'bytes'): void {
    if (!this.sealed) {
      this.sealed = true
      this.truncationReason = reason
    }
  }

  private nextDelay(nowMs: number): number {
    const rawMs = Math.max(0, nowMs - this.lastMs)
    this.lastMs = nowMs
    const delay = roundDelay(rawMs)
    // 单调不减:四舍五入可能让相邻帧相等,不允许回退。
    this.lastDelay = delay >= this.lastDelay ? delay : this.lastDelay
    return this.lastDelay
  }

  /** 追加一个事件并按 v2 语义计算 delay。封存或超限后静默丢弃。 */
  push(type: CastEventType, data: string): void {
    const byteLength = utf8ByteLength(data)
    if (!this.canAccept(byteLength)) return
    const delay = this.nextDelay(monotonicMs())
    this.events.push([delay, type, data])
    this.bytes += byteLength
  }

  /** 输出帧。 */
  write(data: string): void {
    this.push('o', data)
  }

  /** 标记帧(可选命令:用户在会话里触发“标记此处”)。 */
  mark(label: string = 'mark'): void {
    this.push('m', label)
  }

  /** 尺寸调整帧(data 形如 "80x24");header 保留初始尺寸,播放时由播放器在 'r' 处重建。 */
  resize(width: number, height: number): void {
    if (this.sealed) return
    const data = `${sanitizeWidth(width)}x${sanitizeHeight(height)}`
    this.pushRaw('r', data)
  }

  /** 手动封存:此后不再吸收事件(幂等)。 */
  seal(): void {
    this.sealed = true
  }

  /** 生成完整 CastFile(含 header 与事件快照)。 */
  toCast(meta: CastWriterMeta = {}): CastFile {
    const cast: CastFile = {
      version: 2,
      width: this.width,
      height: this.height,
      timestamp: meta.timestamp ?? castTimestamp(),
      events: this.events.map((event) => [event[0], event[1], event[2]] as CastEvent),
    }
    if (meta.title !== undefined) cast.title = meta.title
    if (meta.env !== undefined) cast.env = { ...meta.env }
    else cast.env = defaultCastEnv()
    if (meta.idle_time_limit !== undefined) cast.idle_time_limit = meta.idle_time_limit
    else if (this.options.idleTimeLimit !== undefined) cast.idle_time_limit = this.options.idleTimeLimit
    if (meta.command !== undefined) cast.command = meta.command
    else if (this.options.command !== undefined) cast.command = this.options.command
    return cast
  }

  /** 序列化为 v2 JSON 文本。 */
  toJSON(meta: CastWriterMeta = {}, space?: number): string {
    return JSON.stringify(this.toCast(meta), null, space)
  }

  private pushRaw(type: CastEventType, data: string): void {
    const byteLength = utf8ByteLength(data)
    if (!this.canAccept(byteLength)) return
    const delay = this.nextDelay(monotonicMs())
    this.events.push([delay, type, data])
    this.bytes += byteLength
  }
}

/** UTF-8 字节长度(不依赖 Buffer,保持纯函数)。 */
export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  // 兜底:ASCII 近似 + 非 ASCII 按 2 字节估算(仅用于字节护栏,非精确)。
  let bytes = 0
  for (const ch of text) bytes += ch.charCodeAt(0) > 0x7f ? 2 : 1
  return bytes
}

// ---------------------------------------------------------------------------
// Reader / 校验
// ---------------------------------------------------------------------------

/** 一条解析期发现的问题(条数不影响继续解析,容错读取)。 */
export interface CastParseIssue {
  /** JSON 路径,如 `events[3][1]`。 */
  path: string
  message: string
}

export interface CastParseResult {
  /** JSON 可解析且 events 为数组时返回对象;否则为 null。 */
  cast: CastFile | null
  issues: CastParseIssue[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCastEventType(value: unknown): value is CastEventType {
  return value === 'o' || value === 'i' || value === 'm' || value === 'r'
}

/**
 * 解析 v2 .cast 文本(容错):结构合法则返回 cast 对象与问题清单;
 * JSON 非法或 events 非数组时 cast 为 null。
 */
export function parseCast(text: string): CastParseResult {
  const issues: CastParseIssue[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { cast: null, issues: [{ path: '$', message: `invalid JSON: ${message}` }] }
  }
  if (!isRecord(raw)) {
    return { cast: null, issues: [{ path: '$', message: '顶层必须是 JSON 对象' }] }
  }

  const version = raw['version']
  if (version !== 2) {
    issues.push({ path: 'version', message: `version 必须为 2,got ${JSON.stringify(version)}` })
  }

  const width = typeof raw['width'] === 'number' ? sanitizeWidth(raw['width'] as number) : DEFAULT_WIDTH
  const height = typeof raw['height'] === 'number' ? sanitizeHeight(raw['height'] as number) : DEFAULT_HEIGHT
  if (typeof raw['width'] !== 'number') issues.push({ path: 'width', message: 'width 缺失或非数字,回退默认值' })
  if (typeof raw['height'] !== 'number') issues.push({ path: 'height', message: 'height 缺失或非数字,回退默认值' })

  const timestamp = typeof raw['timestamp'] === 'number' ? raw['timestamp'] : undefined
  const title = typeof raw['title'] === 'string' ? raw['title'] : undefined
  const idleTimeLimit = typeof raw['idle_time_limit'] === 'number' ? raw['idle_time_limit'] : undefined
  const command = typeof raw['command'] === 'string' ? raw['command'] : undefined
  const env = isRecord(raw['env']) ? (raw['env'] as Record<string, string>) : undefined

  const events: CastEvent[] = []
  if (!Array.isArray(raw['events'])) {
    issues.push({ path: 'events', message: 'events 必须是数组' })
  } else {
    let lastDelay = -1
    raw['events'].forEach((entry, index) => {
      const path = `events[${index}]`
      if (!Array.isArray(entry) || entry.length !== 3) {
        issues.push({ path, message: '事件必须是 [delay, type, data] 三元组' })
        return
      }
      const [delayValue, typeValue, dataValue] = entry as [unknown, unknown, unknown]
      let valid = true
      if (typeof delayValue !== 'number' || !Number.isFinite(delayValue) || delayValue < 0) {
        issues.push({ path: `${path}[0]`, message: 'delay 必须是非负数字' })
        valid = false
      }
      if (!isCastEventType(typeValue)) {
        issues.push({ path: `${path}[1]`, message: `事件类型必须为 o/i/m/r,got ${JSON.stringify(typeValue)}` })
        valid = false
      }
      if (typeof dataValue !== 'string') {
        issues.push({ path: `${path}[2]`, message: 'data 必须是字符串' })
        valid = false
      }
      if (!valid) return
      const delay = Math.round((delayValue as number) * 1000) / 1000
      if (delay < lastDelay) {
        issues.push({ path: `${path}[0]`, message: `delay 不满足单调不减(${delay} < ${lastDelay})` })
      }
      lastDelay = delay
      events.push([delay, typeValue as CastEventType, dataValue as string])
    })
  }

  const cast: CastFile = {
    version: 2,
    width,
    height,
    timestamp,
    env,
    events,
  }
  if (title !== undefined) cast.title = title
  if (idleTimeLimit !== undefined) cast.idle_time_limit = idleTimeLimit
  if (command !== undefined) cast.command = command
  return { cast: Array.isArray(raw['events']) ? cast : null, issues }
}

/**
 * 对已解析/构造的 CastFile 做结构校验(验收标准 1:version=2、events 三元组、delay 单调不减)。
 */
export function validateCast(cast: CastFile): CastParseIssue[] {
  const issues: CastParseIssue[] = []
  if (cast.version !== 2) issues.push({ path: 'version', message: `version 必须为 2,got ${cast.version}` })
  if (!Number.isInteger(cast.width) || cast.width < 1) issues.push({ path: 'width', message: 'width 必须为正整数' })
  if (!Number.isInteger(cast.height) || cast.height < 1) issues.push({ path: 'height', message: 'height 必须为正整数' })
  let lastDelay = -1
  cast.events.forEach((event, index) => {
    const path = `events[${index}]`
    if (!Array.isArray(event) || event.length !== 3) {
      issues.push({ path, message: '事件必须是 [delay, type, data] 三元组' })
      return
    }
    const [delay, type, data] = event
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
      issues.push({ path: `${path}[0]`, message: 'delay 必须是非负数字' })
      return
    }
    if (!isCastEventType(type)) issues.push({ path: `${path}[1]`, message: `事件类型必须为 o/i/m/r,got ${JSON.stringify(type)}` })
    if (typeof data !== 'string') issues.push({ path: `${path}[2]`, message: 'data 必须是字符串' })
    if (delay < lastDelay) issues.push({ path: `${path}[0]`, message: `delay 不满足单调不减(${delay} < ${lastDelay})` })
    lastDelay = delay
  })
  return issues
}

// ---------------------------------------------------------------------------
// 文本化(对齐 asciinema cat 语义:输出 → 纯文本,去掉控制序列)
// ---------------------------------------------------------------------------

/** 终端控制序列(CSI/OSC/单字符转义)剥离正则,anansi-regex 同款结构。 */
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/** 剥离 ANSI 控制序列,保留可读文本与换行/回车。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export interface CastToTextOptions {
  /** 是否剥离 ANSI 控制序列,默认 true。 */
  stripAnsi?: boolean
  /** 是否把输入('i')事件一并拼入文本,默认只取输出。 */
  includeInput?: boolean
}

/**
 * .cast → 纯文本:顺序拼接 'o'(可选 'i')事件的 data。
 * 控制序列默认剥离;raw 模式保留原样(终端协议保真,由播放器解释)。
 */
export function castToText(cast: CastFile, options: CastToTextOptions = {}): string {
  const strip = options.stripAnsi ?? true
  const includeInput = options.includeInput ?? false
  let output = ''
  for (const event of cast.events) {
    if (event[1] === 'o' || (includeInput && event[1] === 'i')) {
      output += event[2]
    }
  }
  return strip ? stripAnsi(output) : output
}

/** 播放时长(秒)= 各帧 delay 之和(近似)。 */
export function castDuration(cast: CastFile): number {
  let total = 0
  for (const event of cast.events) total += event[0]
  return Math.round(total * 1000) / 1000
}

/** 供 <script type="application/json"> 内嵌:转义 "</script"。 */
export function jsonForEmbed(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/')
}
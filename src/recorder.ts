/**
 * 会话录制器:订阅当前 Agent 会话的 `session/event` 事件流
 * (tool/result 输出、可选 user/message 输入、step/end 命令边界),
 * 把文本缓冲为 asciinema v2 事件。输入事件默认不录(隐私默认)。
 *
 * 录制来源对齐 DSH 管道:无需依赖 terminals 服务 —— `tool/result`
 * (packages/core/tools 事件流)已携带每次工具输出的文本,是低侵入式来源。
 *
 * @module dsh-asciinema/recorder
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import {
  CastWriter,
  defaultCastEnv,
  type CastFile,
  type CastWriterOptions,
} from './cast-core.ts'

export type RecordingScope = 'session' | 'command'

/**
 * 推导会话标识:优先 DSH Session 的 `id`(会话唯一身份,subagent/多会话同进程时各不相同);
 * 拿不到时(session 缺失或没有 id,如单会话/测试桩)回退 `'default'`,保证注册表仍可用。
 */
export function sessionKeyOf(session: Session | undefined): string {
  if (session !== undefined) {
    const id = (session as { readonly id?: unknown }).id
    if (typeof id === 'string' && id !== '') return id
  }
  return 'default'
}

export interface RecorderStartOptions {
  /** 录制名(写盘文件名基名)。 */
  name: string
  /** session:一直录到显式 stop;command:当前 step 结束自动封存。 */
  scope: RecordingScope
  /** 播放器标题;缺省用录制名。 */
  title?: string
  /** 是否把用户输入('i')也录进 cast(默认 false,隐私默认)。 */
  recordInput?: boolean
  /** 是否未命名(自动取名)录制 —— 会话结束时自动丢弃或不保存。 */
  autoNamed?: boolean
  /** 底层 CastWriter 选项(宽高/容量上限)。 */
  writerOptions?: CastWriterOptions
}

/** 从 ContentBlock 数组提取可见文本(递归进 tool-result 内层)。 */
export function contentToText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let text = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'tool-result':
        text += contentToText(block.content)
        break
      default:
        // reasoning/image/tool-call 不入录制文本
        break
    }
  }
  return text
}

/**
 * 一次活动录制。持有监听句柄,stop()/会话销毁后自动解绑;
 * 所有副作用都挂在 ctx 生命周期上,插件卸载时随 ctx 一起清理。
 */
export class SessionRecorder {
  readonly name: string
  readonly scope: RecordingScope
  readonly startTime: number
  readonly autoNamed: boolean
  readonly recordInput: boolean

  private readonly ctx: Context
  private readonly session: Session
  private readonly writer: CastWriter
  private readonly disposers: Array<() => void> = []
  private active = true
  private _stopReason: 'tool/stop' | 'step/end' | 'session/disposed' | 'dispose' | undefined = undefined
  private finalResult: CastFile | undefined = undefined

  constructor(ctx: Context, session: Session, options: RecorderStartOptions) {
    this.ctx = ctx
    this.session = session
    this.name = options.name
    this.scope = options.scope
    this.startTime = Date.now()
    this.autoNamed = options.autoNamed ?? false
    this.recordInput = options.recordInput ?? false
    this.writer = new CastWriter({
      width: options.writerOptions?.width,
      height: options.writerOptions?.height,
      maxEvents: options.writerOptions?.maxEvents,
      maxBytes: options.writerOptions?.maxBytes,
      idleTimeLimit: options.writerOptions?.idleTimeLimit,
      command: options.writerOptions?.command ?? (options.scope === 'command' ? `term_rec ${options.name}` : undefined),
    })
  }

  private readonly onSessionEvent = (subject: Session, event: SessionEvent): void => {
    if (subject !== this.session || !this.active) return
    this.handleEvent(event)
  }

  private readonly onSessionDisposed = (subject: Session): void => {
    if (subject !== this.session) return
    this.finish('session/disposed')
  }

  /** 开始监听(幂等);句柄通过 ctx.on 返回的 disposer 管理,生命周期随 ctx。 */
  start(): this {
    this.disposers.push(this.ctx.on('session/event', this.onSessionEvent))
    this.disposers.push(this.ctx.on('session/disposed', this.onSessionDisposed))
    return this
  }

  private handleEvent(event: SessionEvent): void {
    // 注意延迟以事件到达顺序计算,而非事件时间戳 —— 与 v2 相对时间轴一致。
    switch (event.type) {
      case 'tool/result': {
        const blocks = event.data.message.content[0]?.content
        const text = contentToText(blocks)
        if (text !== '') this.writer.write(text)
        break
      }
      case 'user/message': {
        if (!this.recordInput) break
        const text = contentToText(event.data.content)
        if (text !== '') this.writer.push('i', text)
        break
      }
      case 'step/end': {
        // command 范围:当前 agent 步骤结束即封存。
        if (this.scope === 'command') this.finish('step/end')
        break
      }
      default:
        break
    }
  }

  get isActive(): boolean {
    return this.active
  }

  /** 被录制会话(注册表按会话回收/丢弃时需要)。 */
  get sessionOf(): Session {
    return this.session
  }

  get stopReason(): string | undefined {
    return this._stopReason
  }

  get eventCount(): number {
    return this.writer.eventCount
  }

  get byteSize(): number {
    return this.writer.byteSize
  }

  get isTruncated(): boolean {
    return this.writer.isTruncated
  }

  get truncationCause(): 'events' | 'bytes' | undefined {
    return this.writer.truncationCause
  }

  get elapsedSeconds(): number {
    return this.writer.elapsed
  }

  /** 插入 marker 事件(用户在会话里触发“标记此处”)。 */
  mark(label: string = 'mark'): boolean {
    if (!this.active) return false
    this.writer.mark(label)
    return true
  }

  /** 调整录制几何(对应 v2 'r' 事件)。 */
  resize(width: number, height: number): boolean {
    if (!this.active) return false
    this.writer.resize(width, height)
    return true
  }

  /**
   * 停止录制并生成 CastFile(writer header 与事件快照)。
   * 幂等:再次调用返回同一个封存结果。
   */
  stop(): CastFile | undefined {
    return this.finish('tool/stop')
  }

  /** 已生成的最终 cast(供 stop 之后在注册表中保存)。 */
  get finalCast(): CastFile | undefined {
    return this.finalResult
  }

  private finish(reason: 'tool/stop' | 'step/end' | 'session/disposed' | 'dispose'): CastFile | undefined {
    if (!this.active) return this.finalResult
    this.active = false
    this._stopReason = reason
    this.writer.seal()
    for (const dispose of this.disposers) dispose()
    const cast = this.writer.toCast({
      title: this.name,
      env: defaultCastEnv(),
    })
    this.finalResult = cast
    return cast
  }
}

/**
 * 录制注册表:注册表键 = `${会话标识}:${录制名}`(会话维度隔离),
 * 因此不同会话(subagent/多用户)的同名录制互不可见、不可 stop/mark/take;
 * 同会话下同名仍冲突。另按会话对象维护一份列表,供会话结束回收/丢弃。
 */
export class RecorderRegistry {
  private readonly byKey = new Map<string, SessionRecorder>()
  private readonly bySession = new Map<Session, SessionRecorder[]>()

  /** 注册表键:会话维度 + 录制名。 */
  private keyFor(session: Session | undefined, name: string): string {
    return `${sessionKeyOf(session)}:${name}`
  }

  /** 开始一个新录制;同会话同名冲突时抛错(调用方转成工具错误返回)。 */
  start(ctx: Context, session: Session, options: RecorderStartOptions): SessionRecorder {
    const key = this.keyFor(session, options.name)
    if (this.byKey.has(key)) {
      throw new Error(`同会话已存在同名录制「${options.name}」,请先 term_rec action=stop`)
    }
    const recorder = new SessionRecorder(ctx, session, options).start()
    this.byKey.set(key, recorder)
    const list = this.bySession.get(session) ?? []
    list.push(recorder)
    this.bySession.set(session, list)
    return recorder
  }

  /** 按会话范围取录制:会话 A 只能取到自己会话的录制。 */
  get(name: string, session?: Session): SessionRecorder | undefined {
    return this.byKey.get(this.keyFor(session, name))
  }

  getNameOf(recorder: SessionRecorder): string | undefined {
    for (const [key, rec] of this.byKey) {
      if (rec === recorder) return key.slice(key.indexOf(':') + 1)
    }
    return undefined
  }

  /** 当前活动(未封存)的录制,按时间顺序;给会话则只列该会话的。 */
  active(session?: Session): SessionRecorder[] {
    const active = [...this.byKey.values()].filter((rec) => rec.isActive)
    if (session === undefined) return active
    return active.filter((rec) => rec.sessionOf === session)
  }

  /** 指定会话下唯一的活动录制(会话限定),多个时返回 undefined。 */
  soloActiveOf(session: Session): SessionRecorder | undefined {
    const list = this.active(session)
    return list.length === 1 ? list[0] : undefined
  }

  /** 指定会话下仍挂在注册表中的录制。 */
  forSession(session: Session): SessionRecorder[] {
    return this.bySession.get(session) ?? []
  }

  /** 按会话范围取出并移除注册项(同时停止录制),供写盘保存。 */
  take(name: string, session?: Session): SessionRecorder | undefined {
    const key = this.keyFor(session, name)
    const recorder = this.byKey.get(key)
    if (recorder === undefined) return undefined
    this.byKey.delete(key)
    const list = this.bySession.get(recorder.sessionOf) ?? []
    const index = list.indexOf(recorder)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) this.bySession.delete(recorder.sessionOf)
    recorder.stop()
    return recorder
  }

  /** 按会话移除(不返回,供丢弃路径)。 */
  dropSession(session: Session): SessionRecorder[] {
    const list = this.bySession.get(session) ?? []
    for (const recorder of list) {
      this.byKey.delete(this.keyFor(recorder.sessionOf, recorder.name))
      recorder.stop()
    }
    this.bySession.delete(session)
    return list
  }

  get count(): number {
    return this.byKey.size
  }
}
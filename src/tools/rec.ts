/**
 * term_rec — 开始/停止录制(按会话或按命令),支持 marker 标记与状态查询。
 *
 * 语义对齐官方 asciinema rec:本工具负责「开始录制 → 缓冲输出 → 停止并写盘」。
 * 录制来源为当前 Agent 会话的 tool/result 事件流;输入事件默认不录(隐私默认)。
 *
 * @module dsh-asciinema/tools/rec
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import type { AsciinemaConfig } from '../index.ts'
import { RecorderRegistry, type RecordingScope } from '../recorder.ts'
import { saveCastFile, sanitizeName } from '../cast-io.ts'
import { castDuration } from '../cast-core.ts'

export type TermRecAction = 'start' | 'stop' | 'mark' | 'status'

export interface TermRecArgs {
  action?: TermRecAction
  name?: string
  scope?: RecordingScope
  record_input?: boolean
  marker?: string
}

export interface TermRecResult {
  status: string
  message: string
  name?: string
  scope?: string
  path?: string
  absPath?: string
  events?: number
  truncated?: boolean
  duration?: number
}

export interface RecToolDeps {
  ctx: Context
  registry: RecorderRegistry
  config: AsciinemaConfig
}

/** 未命名时的时间戳基名。 */
function timestampName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`
}

function defaultName(scope: RecordingScope, requested: string | undefined): { name: string; autoNamed: boolean } {
  if (requested !== undefined && requested !== '') return { name: sanitizeName(requested), autoNamed: false }
  return { name: timestampName(scope === 'command' ? 'cmd' : 'session'), autoNamed: true }
}

/** 状态/提示的纯文本渲染(从返回值构建,遵守 output.render 纯函数约束)。 */
function renderRec(value: TermRecResult): string {
  const lines: string[] = []
  switch (value.status) {
    case 'recording':
      lines.push(`🎬 录制中:${value.name ?? ''} (${value.scope ?? 'session'}) — 工具输出将被缓冲为 v2 cast`)
      lines.push('  停止:term_rec action=stop  name=<同款名>')
      break
    case 'saved':
      lines.push(`💾 已保存 ${value.path ?? ''}（${value.events ?? 0} 事件,${value.duration ?? 0}s）`)
      if (value.truncated === true) lines.push('  ⚠️ 已达到容量上限,录制已封存(后续输出不再记录)')
      lines.push('  回放:term_play path=<该路径>  /  文本:term_cat path=<该路径>')
      break
    case 'discarded':
      lines.push(`🗑️ ${value.message}`)
      break
    case 'mark':
      lines.push(`📍 ${value.message}`)
      break
    default:
      lines.push(value.message)
  }
  return lines.join('\n')
}

export function createTermRecTool(deps: RecToolDeps): ToolDefinition {
  return defineTool({
    name: 'term_rec',
    description:
      '开始/停止把当前会话的工具输出录制为 asciinema v2 (.cast) 文件。' +
      'action=start 开始(scope=session 录到显式 stop;scope=command 在当前步骤结束时自动封存),' +
      '同名再调 action=stop 停止并写盘到工作区 .casts/ 目录;' +
      'action=mark 在录制中插入标记;action=status 查询活动录制。' +
      '隐私默认:只录输出,不录输入(record_input=true 才录)。',
    parameters: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'mark', 'status'],
        description: '操作,默认 start',
      },
      name: {
        type: 'string',
        description: '录制名(写盘文件基名);缺省自动生成,自动命名的录制在会话结束后自动丢弃',
      },
      scope: {
        type: 'string',
        enum: ['session', 'command'],
        description: '录制范围,默认 session',
      },
      record_input: {
        type: 'boolean',
        description: '是否记录用户输入事件,默认 false(隐私默认)',
      },
      marker: {
        type: 'string',
        description: 'action=mark 时的标记文案',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          message: { type: 'string', required: true },
          name: { type: 'string' },
          scope: { type: 'string' },
          path: { type: 'string' },
          absPath: { type: 'string' },
          events: { type: 'number' },
          truncated: { type: 'boolean' },
          duration: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRec(value) }],
      presentationMeta: (_args, value) => value as unknown as JsonValue,
    },
    async execute(args: TermRecArgs, exec: ToolRunContext) {
      const action = args.action ?? 'start'
      const session = exec.agent?.session

      if (action === 'status') {
        // 只列出当前会话的活动录制(跨会话隔离)。
        const active = deps.registry.active(session)
        const list = active.map((rec) => `「${rec.name}」(${rec.scope},${rec.eventCount} 事件)`)
        return {
          status: 'ok',
          message: list.length > 0 ? `录制中:${list.join(', ')}` : '当前没有活动录制',
          events: active.reduce((sum, rec) => sum + rec.eventCount, 0),
        }
      }

      if (session === undefined) {
        return {
          status: 'error',
          message: 'term_rec 只能在会话内调用(缺少 agent 会话上下文)',
        }
      }

      if (action === 'start') {
        const scope = args.scope ?? 'session'
        const { name, autoNamed } = defaultName(scope, args.name)
        if (deps.registry.get(name, session) !== undefined) {
          return { status: 'error', message: `本会话已有同名录制「${name}」,请先 term_rec action=stop` }
        }
        const recorder = deps.registry.start(deps.ctx, session, {
          name,
          scope,
          autoNamed,
          recordInput: args.record_input ?? deps.config.recordInput,
          writerOptions: {
            width: deps.config.width,
            height: deps.config.height,
            maxEvents: deps.config.maxEvents,
            maxBytes: deps.config.maxBytes,
          },
        })
        return {
          status: 'recording',
          name,
          scope,
          message: `开始录制「${name}」(${scope})`,
        }
      }

      if (action === 'mark') {
        const rec = args.name !== undefined
          ? deps.registry.get(sanitizeName(args.name), session)
          : deps.registry.soloActiveOf(session)
        if (rec === undefined) {
          return { status: 'error', message: '本会话没有活动录制可标记(先 term_rec action=start)' }
        }
        const ok = rec.mark(args.marker ?? 'mark')
        if (!ok) return { status: 'error', message: `录制「${rec.name}」已停止,无法插入标记` }
        return { status: 'mark', name: rec.name, events: rec.eventCount, message: `已在「${rec.name}」插入标记` }
      }

      // action === 'stop':只按当前会话找到并停止录制(跨会话隔离)。
      const requested = args.name !== undefined ? sanitizeName(args.name) : undefined
      const recorder = requested !== undefined ? deps.registry.take(requested, session) : (() => {
        const solo = deps.registry.soloActiveOf(session)
        return solo !== undefined ? deps.registry.take(solo.name, session) : undefined
      })()
      if (recorder === undefined) {
        return { status: 'error', message: '本会话没有可停止的录制(先 term_rec action=start 或指定存在 name)' }
      }

      const cast = recorder.finalCast ?? recorder.stop()
      if (cast === undefined) {
        return { status: 'error', message: `录制「${recorder.name}」没有可保存的内容` }
      }

      // 未命名且无内容 → 丢弃
      if (recorder.autoNamed && cast.events.length === 0) {
        return {
          status: 'discarded',
          name: recorder.name,
          message: '未命名录制没有任何输出,已自动丢弃(命名录制后即可保存)',
        }
      }

      const saved = await saveCastFile(
        deps.ctx,
        session,
        deps.config.castsDir,
        recorder.name,
        cast,
        exec.signal,
      )
      return {
        status: 'saved',
        name: recorder.name,
        scope: recorder.scope,
        path: saved.relPath,
        absPath: saved.absPath,
        events: cast.events.length,
        truncated: recorder.isTruncated,
        duration: castDuration(cast),
        message: `已保存录制「${recorder.name}」`,
      }
    },
  })
}
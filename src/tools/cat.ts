/**
 * term_cat — .cast → 纯文本(对齐 asciinema cat 语义:输出事件拼接、去控制序列)。
 *
 * @module dsh-asciinema/tools/cat
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { readCastText } from '../cast-io.ts'
import { castToText, parseCast } from '../cast-core.ts'

export interface TermCatArgs {
  path: string
  raw?: boolean
  include_input?: boolean
}

export interface CatToolDeps {
  ctx: Context
}

export function createTermCatTool(deps: CatToolDeps): ToolDefinition {
  return defineTool({
    name: 'term_cat',
    description:
      '把一个 asciinema v2 (.cast) 文件转为纯文本(asciinema cat 语义):顺序拼接输出事件,' +
      '默认剥离 ANSI 控制序列;raw=true 保留控制序列原文(终端协议保真)。' +
      '路径相对会话工作区,如 .casts/demo.cast。',
    parameters: {
      path: { type: 'string', required: true, description: '.cast 文件路径(相对会话工作区)' },
      raw: { type: 'boolean', description: '保留 ANSI 控制序列,默认 false(剥离)' },
      include_input: { type: 'boolean', description: '是否把输入(i)事件也拼入文本,默认 false' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => {
        const header = `▶ ${args.path}(${value.length} 字符)`
        return [{ type: 'text', text: `${header}\n${value}` }]
      },
      presentationMeta: (_args, value) => ({ type: 'asciinema-cat', chars: value.length }),
    },
    async execute(args: TermCatArgs, exec: ToolRunContext) {
      const session = exec.agent?.session
      const raw = await readCastText(deps.ctx, session, args.path, exec.signal)
      const parsed = parseCast(raw)
      if (parsed.cast === null) {
        const first = parsed.issues[0]
        throw new Error(`无法解析 .cast 文件:${first !== undefined ? first.message : 'unknown error'}(path=${args.path})`)
      }
      return castToText(parsed.cast, {
        stripAnsi: !(args.raw ?? false),
        includeInput: args.include_input ?? false,
      })
    },
  })
}
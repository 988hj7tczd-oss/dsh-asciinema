/**
 * dsh-asciinema — 终端会话录制与回放(asciinema v2 格式)。
 *
 * 装配:注册 3 个工具(term_rec / term_play / term_cat)+ 会话录制器注册表,
 * 并处理“会话结束后:命名录制自动保存、未命名录制自动丢弃”的策略。
 * 录制来源为 `session/event` 事件流中的 tool/result 输出(低侵入,不依赖 terminals)。
 *
 * @module dsh-asciinema
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import { RecorderRegistry } from './recorder.ts'
import { createTermRecTool } from './tools/rec.ts'
import { createTermPlayTool } from './tools/play.ts'
import { createTermCatTool } from './tools/cat.ts'
import { saveCastFile } from './cast-io.ts'

/** Cordis 插件名(bundle patch 中 name: dsh-asciinema 解析到本模块)。 */
export const name = 'dsh-asciinema'

/** 插件配置:所有可调项都由 cordis.yml 的 config 覆写。 */
export interface AsciinemaConfig {
  /** 录制几何宽度(header width),默认 100。 */
  width: number
  /** 录制几何高度(header height),默认 40。 */
  height: number
  /** 事件条数上限,超过后封存(truncated),默认 5000。 */
  maxEvents: number
  /** 缓冲数据字节上限,超过后封存,默认 1 MiB。 */
  maxBytes: number
  /** 隐私默认:录制输入事件开关,默认 false(只录输出)。 */
  recordInput: boolean
  /** 录制落盘目录(相对会话工作区),默认 .casts。 */
  castsDir: string
  /** 预留字段,未实现:当前源码不消费该配置(播放器一律用内嵌离线模板)。 */
  playerUrl?: string
}

export const Config: Schema<AsciinemaConfig> = Schema.object({
  width: Schema.number().step(1).min(1).max(1000).default(100),
  height: Schema.number().step(1).min(1).max(1000).default(40),
  maxEvents: Schema.number().step(1).min(1).default(5000),
  maxBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
  recordInput: Schema.boolean().default(false),
  castsDir: Schema.string().default('.casts'),
  playerUrl: Schema.string().default(''),
})

/** 依赖:工具注册表 + 文件系统(会话工作区)。 */
export const inject = ['tools', 'fs']

export function apply(ctx: Context, config: AsciinemaConfig) {
  const registry = new RecorderRegistry()

  // 会话结束策略(验收标准 4):命名录制自动保存,未命名录制自动丢弃。
  ctx.on('session/disposed', (session: Session) => {
    const recorders = registry.forSession(session)
    if (recorders.length === 0) return
    registry.dropSession(session)
    for (const recorder of recorders) {
      if (recorder.autoNamed) {
        console.warn(`[dsh-asciinema] 未命名录制「${recorder.name}」随会话结束自动丢弃`)
        continue
      }
      const cast = recorder.finalCast
      if (cast === undefined || cast.events.length === 0) continue
      void saveCastFile(ctx, session, config.castsDir, recorder.name, cast, new AbortController().signal)
        .then((saved) => {
          console.info(`[dsh-asciinema] 会话结束,录制已保存:${saved.relPath}(${cast.events.length} 事件)`)
        })
        .catch((error: unknown) => {
          console.warn(`[dsh-asciinema] 会话结束自动保存失败:${error instanceof Error ? error.message : String(error)}`)
        })
    }
  })

  // 生命周期:所有注册都在 ctx.effect 内,插件卸载/热替换时自动清理。
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(createTermRecTool({ ctx, registry, config })),
      ctx.tools.register(createTermPlayTool({ ctx, config })),
      ctx.tools.register(createTermCatTool({ ctx })),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
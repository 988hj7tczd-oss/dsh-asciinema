/**
 * term_play — 回放 .cast:生成内嵌 asciinema-player 的离线 HTML(默认),
 * 会话内返回可点击文件;text 模式输出 cat 文本(无浏览器时兜底)。
 *
 * @module dsh-asciinema/tools/play
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import type { AsciinemaConfig } from '../index.ts'
import {
  readCastText,
  resolveTarget,
  loadPlayerTemplate,
  renderPlayerHtml,
  htmlPathForCast,
} from '../cast-io.ts'
import { castToText, castDuration, parseCast, validateCast } from '../cast-core.ts'

export type TermPlayMode = 'auto' | 'html' | 'text'

export interface TermPlayArgs {
  path: string
  mode?: TermPlayMode
}

export interface TermPlayResult {
  mode: 'html' | 'text'
  path: string
  htmlPath?: string
  events: number
  duration: number
  width: number
  height: number
  title?: string
  text?: string
  issues: string[]
}

/** 缺省导出模板(assets/player.html 缺失时的兜底,保证 html 模式仍可用)。 */
const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>__TITLE__ — asciinema 回放</title>
<style>body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#111;color:#eee;padding:2rem}
#stage{white-space:pre-wrap;line-height:1.2;max-width:80ch}#bar{display:flex;gap:1rem;align-items:center;margin-bottom:1rem;color:#aaa}
button{background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:.3rem .8rem;cursor:pointer}
</style></head>
<body>
<h2>__TITLE__</h2>
<div id="bar">
<button id="btn-play">▶ 播放</button>
<button id="btn-reset">⟲ 复位</button>
<span id="cur">0.000s</span>/<span id="tot">0s</span>
<select id="speed"><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option><option value="0.5">0.5x</option></select>
</div>
<pre id="stage"></pre>
<script type="application/json" id="cast-data">__CAST_JSON__</script>
<script>
const cast = JSON.parse(document.getElementById('cast-data').textContent);
const stage = document.getElementById('stage');
let lines = [], idx = 0, timer = null, playing = false;
const SCREEN = /[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))/g;
function append(chunk) { lines.push(...chunk.replace(SCREEN, '').split(/\\n/)); if (lines.length > cast.height) lines = lines.slice(-cast.height); }
function render() { stage.textContent = lines.join('\\n').slice(-200000); }
function reset() { stop(); lines = []; idx = 0; cur(0); for (const e of cast.events) if (e[1] === 'o') append(e[2]); render(); cur(cast.events[0] && cast.events[0][0] || 0); }
function cur(t) { document.getElementById('cur').textContent = t.toFixed(3) + 's'; }
function stop() { if (timer) clearTimeout(timer); timer = null; playing = false; document.getElementById('btn-play').textContent = '▶ 播放'; }
function step() {
  if (idx >= cast.events.length) { stop(); reset(); return; }
  const e = cast.events[idx++];
  if (e[1] === 'o') append(e[2]);
  const d = Math.max(e[0], 0.001) / Number(document.getElementById('speed').value);
  cur(cast.events.slice(0, idx).reduce((s, x) => s + x[0], 0));
  timer = setTimeout(step, d * 1000);
}
document.getElementById('btn-play').onclick = () => { if (playing) { stop(); return; } playing = true; document.getElementById('btn-play').textContent = '⏸ 暂停'; step(); };
document.getElementById('btn-reset').onclick = reset;
const total = cast.events.reduce((s, x) => s + x[0], 0);
document.getElementById('tot').textContent = total.toFixed(1) + 's';
reset();
</script>
</body></html>`

export interface PlayToolDeps {
  ctx: Context
  config: AsciinemaConfig
}

export function createTermPlayTool(deps: PlayToolDeps): ToolDefinition {
  return defineTool({
    name: 'term_play',
    description:
      '回放一个 asciinema v2 (.cast) 文件。默认 mode=html:把播放器模板与 cast 数据内嵌成自包含 HTML(离线可播),' +
      '写到 .cast 同目录并返回可点击链接;mode=text 输出去除控制序列的纯文本(无浏览器环境时用这个)。' +
      '路径相对会话工作区,如 .casts/demo.cast。',
    parameters: {
      path: { type: 'string', required: true, description: '.cast 文件路径(相对会话工作区)' },
      mode: {
        type: 'string',
        enum: ['auto', 'html', 'text'],
        description: '回放模式,默认 auto(html;text 为兜底)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          path: { type: 'string', required: true },
          htmlPath: { type: 'string' },
          events: { type: 'number', required: true },
          duration: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          title: { type: 'string' },
          text: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (args, value) => {
        const lines: string[] = []
        if (value.mode === 'html') {
          lines.push(`▶ 回放已生成:${value.htmlPath ?? ''}（${value.events} 事件,约 ${value.duration}s,${value.width}×${value.height}）`)
          lines.push(`  点击打开:${value.htmlPath ?? ''}(离线 HTML,可直接浏览器打开)`)
          if (value.title !== undefined) lines.push(`  标题:${value.title}`)
          lines.push(`  文本化:term_cat path=${args.path}  /  text 模式:term_play path=${args.path} mode=text`)
        } else {
          lines.push(`▶ 文本化回放(${value.events} 事件,约 ${value.duration}s):`)
          lines.push('```console')
          lines.push(value.text ?? '')
          lines.push('```')
        }
        if (value.issues.length > 0) {
          lines.push(`⚠ 解析告警:${value.issues.join('; ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({
        type: 'asciinema-playback',
        path: value.path,
        htmlPath: value.htmlPath,
        events: value.events,
        duration: value.duration,
      }) as JsonValue,
    },
    async execute(args: TermPlayArgs, exec: ToolRunContext) {
      const session = exec.agent?.session
      const raw = await readCastText(deps.ctx, session, args.path, exec.signal)
      const parsed = parseCast(raw)
      if (parsed.cast === null) {
        const first = parsed.issues[0]
        throw new Error(`无法解析 .cast 文件:${first !== undefined ? first.message : 'unknown error'}(path=${args.path})`)
      }
      const cast = parsed.cast
      const seen = new Set(parsed.issues.map((issue) => issue.message))
      const warnings = validateCast(cast).filter((issue) => {
        if (seen.has(issue.message)) return false
        seen.add(issue.message)
        return true
      })
      const issues = [...seen]

      const mode = args.mode ?? 'auto'
      if (mode === 'text') {
        return {
          mode: 'text',
          path: args.path,
          events: cast.events.length,
          duration: castDuration(cast),
          width: cast.width,
          height: cast.height,
          title: cast.title,
          text: castToText(cast),
          issues,
        }
      }

      // html(默认)/auto:生成自包含回放页
      const template = (await loadPlayerTemplate(deps.ctx, exec.signal)) ?? FALLBACK_TEMPLATE
      const html = renderPlayerHtml(template, cast, cast.title ?? args.path)
      const htmlPath = htmlPathForCast(args.path)
      const target = await resolveTarget(deps.ctx, session, htmlPath, exec.signal)
      await deps.ctx.fs.writeText(target, html, undefined, exec.signal)
      return {
        mode: 'html',
        path: args.path,
        htmlPath,
        events: cast.events.length,
        duration: castDuration(cast),
        width: cast.width,
        height: cast.height,
        title: cast.title,
        issues,
      }
    },
  })
}
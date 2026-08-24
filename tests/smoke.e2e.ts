/**
 * dsh-asciinema 离线单元级冒烟测试(未挂载 DSH 运行时的纯逻辑覆盖)。
 *
 * 说明:文件名沿用 smoke.e2e.ts,但本测试实为离线单元级冒烟 —— 不构建 Cordis
 * 上下文、不注册工具、不落盘,只覆盖 cast-core / recorder / cast-io 的纯函数
 * 与逻辑接线(含自写 parser 的 round-trip 自证)。未与官方 asciinema
 * play/player 做互操作验证;播放器仅做模板渲染与内嵌 JS 语法级校验,
 * 未在浏览器/DOM 中实际执行播放流程。
 *
 * 运行:node --no-warnings tests/smoke.e2e.ts(pnpm test)
 * 覆盖:cast-core(writer/reader/校验/文本化/封存)、recorder 事件接线与
 *      注册表跨会话隔离、播放器模板渲染与资产存在性。
 *
 * @module tests/smoke
 */

import { readFile } from 'node:fs/promises'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import {
  CastWriter,
  castToText,
  castTimestamp,
  castDuration,
  defaultCastEnv,
  jsonForEmbed,
  parseCast,
  sanitizeWidth,
  sanitizeHeight,
  stripAnsi,
  validateCast,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  type CastEvent,
  type CastFile,
} from '../src/cast-core.ts'
import {
  SessionRecorder,
  RecorderRegistry,
  contentToText,
  type RecorderStartOptions,
} from '../src/recorder.ts'
import { renderPlayerHtml, htmlPathForCast, sanitizeName } from '../src/cast-io.ts'

// ---------------------------------------------------------------------------
// 微型断言助手(任何失败抛出 → 非零退出码)
// ---------------------------------------------------------------------------

let passed = 0

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败:${message}`)
}

function assertEq(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) {
    throw new Error(`断言失败:${message}\n  期望:${right}\n  实际:${left}`)
  }
}

interface PlannedTest {
  name: string
  fn: () => void | Promise<void>
}

const tests: PlannedTest[] = []

/** 收集测试;main() 中顺序 await 执行,保证异步测试完成后才输出汇总。 */
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

async function runTests(): Promise<void> {
  for (const planned of tests) {
    try {
      await planned.fn()
      passed += 1
      console.log(`  ok — ${planned.name}`)
    } catch (error) {
      console.error(`  FAIL — ${planned.name}`)
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// 1. cast-core:writer 时间轴与结构
//    (验收标准 1 的离线自证:以自写 reader round-trip 验证 v2 结构合法;
//     未与官方 asciinema play/player 做互操作验证,不宣称官方可解析)
// ---------------------------------------------------------------------------

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  test('CastWriter 生成合法 v2 结构:version=2 / 三元组 / 单调不减', async () => {
    const writer = new CastWriter({ width: 100, height: 40 })
    writer.write('hello')
    await waitMs(15)
    writer.write(' world\n')
    await waitMs(10)
    writer.mark('checkpoint')
    writer.resize(120, 50)
    const cast = writer.toCast({ title: 'demo', timestamp: castTimestamp(), env: defaultCastEnv() })

    assertEq(cast.version, 2, 'version 必须为 2')
    assertEq(cast.width, 100, 'width 来自配置')
    assertEq(cast.height, 40, 'height 来自配置')
    assertEq(cast.title, 'demo', 'title 写入 header')
    assert(typeof cast.timestamp === 'number' && cast.timestamp > 0, 'timestamp 必须是正 Unix 秒')
    assert(cast.env !== undefined && cast.env['TERM'] !== undefined, 'env 含 TERM')
    assert(cast.events.length >= 4, '应有输出+标记+尺寸事件')

    const types = cast.events.map((e) => e[1])
    assert(types.includes('o'), '含输出事件')
    assert(types.includes('m'), '含标记事件')
    assert(types.includes('r'), '含尺寸事件')
    const resize = cast.events.find((e) => e[1] === 'r')
    assertEq(resize?.[2], '120x50', 'r 事件 data 形如 "WxH"')

    let last = -1
    for (const event of cast.events) {
      assert(Array.isArray(event) && event.length === 3, '事件必须是三元组')
      assert(typeof event[0] === 'number' && event[0] >= 0, 'delay 必须非负')
      assert(event[0] >= last - 1e-9, 'delay 必须单调不减')
      last = event[0]
      assert(['o', 'i', 'm', 'r'].includes(event[1]), `事件类型合法,got ${event[1]}`)
      assert(typeof event[2] === 'string', 'data 必须是字符串')
    }
    assertEq(validateCast(cast).length, 0, 'validateCast 无问题')

    // 序列化 → 解析回读必须无损
    const text = JSON.stringify(cast)
    const parsed = parseCast(text)
    assert(parsed.cast !== null, 'JSON 往返可解析')
    if (parsed.cast !== null) {
      assertEq(parsed.cast.events.length, cast.events.length, '往返事件数一致')
      assertEq(parsed.cast.events, cast.events, '往返事件完全一致')
      assertEq(validateCast(parsed.cast).length, 0, '往返结果校验通过')
    }
  })

  test('首帧 delay 语义:相对录制开始,后续单调(含同时刻并列帧)', async () => {
    const w1 = new CastWriter()
    w1.write('first')
    const f0 = w1.toCast().events[0] as CastEvent
    assert(f0[0] >= 0, '首帧 delay 相对开始 ≥0')
    const w2 = new CastWriter()
    w2.write('a')
    w2.write('b') // 同一毫秒内的并列帧
    const events = w2.toCast().events
    assertEq(events[1]?.[0], events[0]?.[0], '并列帧 delay 相等(单调不减)')
  })

  test('容量护栏:超过 maxEvents/maxBytes 封存并标记 truncated(验收标准 3)', () => {
    const byEvents = new CastWriter({ maxEvents: 3 })
    byEvents.write('1')
    byEvents.write('2')
    byEvents.write('3')
    byEvents.write('4') // 应被拒绝
    const castA = byEvents.toCast()
    assertEq(castA.events.length, 3, 'maxEvents=3 时只保留 3 条')
    assert(byEvents.isTruncated && byEvents.truncationCause === 'events', 'events 上限触发封存')

    const byBytes = new CastWriter({ maxBytes: 100 })
    byBytes.write('x'.repeat(60))
    byBytes.write('y'.repeat(60)) // 超过后拒绝
    const castB = byBytes.toCast()
    assertEq(castB.events.length, 1, 'maxBytes 上限拒绝后续事件')
    assert(byBytes.isTruncated && byBytes.truncationCause === 'bytes', 'bytes 上限触发封存')
  })

  test('parseCast 容错:坏 version / 坏事件 / delay 回退都给出问题清单', () => {
    const badVersion = parseCast(JSON.stringify({ version: 1, width: 80, height: 24, events: [] }))
    assert(badVersion.cast !== null, 'version 错误仍容错解析')
    assert(badVersion.issues.some((i) => i.path === 'version'), 'version 问题被记录')

    const badEvent = parseCast(JSON.stringify({ version: 2, width: 80, height: 24, events: [[-1, 'x', 42]] }))
    assert(badEvent.issues.length >= 2, '非法三元组逐项记录问题')

    const regression = parseCast(JSON.stringify({
      version: 2, width: 80, height: 24,
      events: [[0.5, 'o', 'a'], [0.2, 'o', 'b']],
    }))
    assert(regression.issues.some((i) => i.message.includes('单调不减')), 'delay 回退被检出')

    const garbage = parseCast('not json')
    assert(garbage.cast === null && garbage.issues.length > 0, '非法 JSON 返回 null + 问题')
  })

  test('尺寸合法性:sanitizeWidth 兜底默认', () => {
    assertEq(sanitizeWidth(undefined), DEFAULT_WIDTH, '缺省用默认宽')
    assertEq(sanitizeWidth(0), 1, '0 归一到 1')
    assertEq(sanitizeWidth(5000), 1000, '超大值收口到 MAX_DIMENSION')
    assertEq(sanitizeWidth(120), 120, '合法值原样')
    assertEq(sanitizeHeight(undefined), DEFAULT_HEIGHT, '缺省用默认高')
  })

  // ---------------------------------------------------------------------------
  // 2. 文本化(验收标准 3 implied:term_cat 语义;控制序列剥离)
  // ---------------------------------------------------------------------------

  test('castToText 剥 ANSI 对齐 asciinema cat;raw 模式保留原样', () => {
    const cast: CastFile = {
      version: 2,
      width: 80,
      height: 24,
      timestamp: castTimestamp(),
      events: [
        [0, 'o', '\u001b[32mOK\u001b[0m line\r\n'],
        [0.1, 'o', 'plain'],
        [0.2, 'i', '(typed input, 默认不拼)'],
      ],
    }
    const text = castToText(cast)
    assert(text.includes('OK') && text.includes('line'), 'SGR 剥离后文本保留')
    assert(!text.includes('\u001b['), '默认剥离控制序列')
    assert(!text.includes('typed input'), '输入事件默认不拼入')

    const raw = castToText(cast, { stripAnsi: false })
    assert(raw.includes('\u001b[32m'), 'raw 模式保留 escape 序列(播放器解释)')

    const withInput = castToText(cast, { includeInput: true })
    assert(withInput.includes('typed input'), 'include_input 后并入输入')
  })

  test('stripAnsi 覆盖 CSI/OSC/单字符转义', () => {
    const sample = '\u001b[?2004h\u001b]0;title\u0007\u001b[38;5;196mred\u001b[39m\u001b[K\u001b[2Jend'
    const result = stripAnsi(sample)
    assertEq(result, 'redend', 'CSI/OSC/私有用途序列全部剥离')
  })

  test('castDuration 计算播放时长', () => {
    const cast: CastFile = {
      version: 2, width: 80, height: 24,
      events: [[0.5, 'o', 'a'], [0.25, 'o', 'b'], [0.25, 'o', 'c']],
    }
    assertEq(castDuration(cast), 1, '时长 = 各帧 delay 之和')
  })

  // ---------------------------------------------------------------------------
  // 3. recorder:事件接线(验收标准 1/4:tool/result → 缓冲;step/end 命令边界;隐私)
  // ---------------------------------------------------------------------------

  interface FakeCtx {
    on(type: string, fn: (...args: unknown[]) => void): () => void
    off(type: string, fn: (...args: unknown[]) => void): void
    emit(type: string, ...args: unknown[]): void
    listenerCount(type: string): number
  }

  function makeFake(): FakeCtx {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    return {
      on(type, fn) {
        let set = listeners.get(type)
        if (set === undefined) { set = new Set(); listeners.set(type, set) }
        set.add(fn)
        return () => {
          listeners.get(type)?.delete(fn)
        }
      },
      off(type, fn) {
        listeners.get(type)?.delete(fn)
      },
      emit(type, ...args) {
        const set = listeners.get(type)
        if (set === undefined) return
        for (const fn of [...set]) fn(...args)
      },
      listenerCount(type) {
        return listeners.get(type)?.size ?? 0
      },
    }
  }

  const fakeSession = { id: 'session-1', header: { cwd: undefined } }

  function toolResultEvent(text: string): Record<string, unknown> {
    return {
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'tool-result', toolCallId: 'call-1' as never, content: [{ type: 'text', text }], isError: false }],
        },
      },
    }
  }

  const userMessageEvent = (text: string): Record<string, unknown> => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text }] },
  })

  test('SessionRecorder 订阅 tool/result 输出并生成 cast', () => {
    const ctx = makeFake()
    const rec = new SessionRecorder(ctx as never, fakeSession as never, {
      name: 'demo-rec',
      scope: 'session',
    } as RecorderStartOptions).start()

    ctx.emit('session/event', fakeSession, toolResultEvent('$ ls\n'))
    ctx.emit('session/event', fakeSession, toolResultEvent('file.txt\n'))
    ctx.emit('session/event', fakeSession, userMessageEvent('输入即使给了也不录'))

    const cast = rec.stop()
    assert(cast !== undefined, 'stop 返回 cast')
    if (cast === undefined) return
    assertEq(cast.events.length, 2, '只录两条输出(输入默认跳过)')
    assertEq(cast.events[1]?.[2], 'file.txt\n', '第二条输出内容正确')
    assert(!rec.isActive, 'stop 后不再活动')
    assertEq(ctx.listenerCount('session/event'), 0, 'stop 后监听已解绑')
    assertEq(ctx.listenerCount('session/disposed'), 0, 'dispose 监听已解绑')
  })

  test('record_input=true 时输入事件以 "i" 录制', () => {
    const ctx = makeFake()
    const rec = new SessionRecorder(ctx as never, fakeSession as never, {
      name: 'demo-input',
      scope: 'session',
      recordInput: true,
    } as RecorderStartOptions).start()
    ctx.emit('session/event', fakeSession, userMessageEvent('ls -la'))
    const cast = rec.stop()
    assert(cast !== undefined && cast.events[0]?.[1] === 'i', '输入事件类型为 i')
  })

  test('command 范围录制在 step/end 自动封存', () => {
    const ctx = makeFake()
    const rec = new SessionRecorder(ctx as never, fakeSession as never, {
      name: 'cmd-x',
      scope: 'command',
    } as RecorderStartOptions).start()
    ctx.emit('session/event', fakeSession, toolResultEvent('构建完成\n'))
    ctx.emit('session/event', fakeSession, { type: 'step/end', data: { turn: 1, step: 1 } })
    assert(!rec.isActive, 'step/end 后自动封存')
    const cast = rec.finalCast
    assert(cast !== undefined && cast.events.length === 1, '封存后仍保留已录内容')
  })

  test('contentToText 递归提取 tool-result 内层文本', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'A' },
      { type: 'tool-result', toolCallId: 'x' as never, content: [{ type: 'text', text: 'B' }] },
      { type: 'reasoning', text: 'skipped' },
    ]
    assertEq(contentToText(blocks), 'AB', 'text + 嵌套 tool-result 文本,reasoning 跳过')
  })

  test('RecorderRegistry:同会话同名冲突 / take / dropSession 语义(第 4 条验收)', () => {
    const ctx = makeFake()
    const registry = new RecorderRegistry()
    const sessionA = fakeSession as never
    registry.start(ctx as never, sessionA, { name: 'n1', scope: 'session' } as RecorderStartOptions)
    let thrown = ''
    try {
      registry.start(ctx as never, sessionA, { name: 'n1', scope: 'session' } as RecorderStartOptions)
    } catch (error) {
      thrown = error instanceof Error ? error.message : 'thrown'
    }
    assert(thrown.includes('同名'), '同会话同名录制冲突被拒')

    const rec = registry.take('n1', sessionA)
    assert(rec !== undefined && registry.get('n1', sessionA) === undefined, 'take 移出注册表')
    assertEq(registry.count, 0, '注册表清空')

    registry.start(ctx as never, sessionA, { name: 'auto-x', scope: 'session', autoNamed: true } as RecorderStartOptions)
    registry.dropSession(sessionA)
    assertEq(registry.count, 0, 'dropSession 丢弃未命名录制')
  })

  test('不同会话同名录制互不干扰(跨会话隔离:H1)', () => {
    const ctx = makeFake()
    const registry = new RecorderRegistry()
    const sessionA = { id: 'session-A', header: { cwd: undefined } } as never
    const sessionB = { id: 'session-B', header: { cwd: undefined } } as never

    const recA = registry.start(ctx as never, sessionA, { name: 'demo', scope: 'session' } as RecorderStartOptions)
    const recB = registry.start(ctx as never, sessionB, { name: 'demo', scope: 'session' } as RecorderStartOptions)
    assertEq(registry.count, 2, '两个会话同名录制同时存在,不冲突')

    assert(registry.get('demo', sessionA) === recA, '会话 A 取到自己的录制')
    assert(registry.get('demo', sessionB) === recB, '会话 B 取到自己的录制')
    assert(registry.get('demo') === undefined, '不带会话按 default 作用域查不到(隔离)')

    // 会话 A 按名 stop/take:只影响 A,不波及 B
    const taken = registry.take('demo', sessionA)
    assert(taken === recA, 'A 按名 take 取到的是 A 自己的录制')
    assert(registry.get('demo', sessionA) === undefined, 'A 的录制已移除')
    assert(registry.get('demo', sessionB) === recB, 'B 的同名录制仍在,未被 A 的 stop 波及')
    assertEq(registry.count, 1, '仅剩 B 的录制')

    // solo 语义同样与会话绑定:A 无活动录制,B 唯一活动录制
    assert(registry.soloActiveOf(sessionA as never) === undefined, 'A 已无活动录制')
    assert(registry.soloActiveOf(sessionB as never) === recB, 'B 的 soloActive 指向 B 自己的录制')
    registry.dropSession(sessionB)
    assertEq(registry.count, 0, 'B 会话结束清空')
  })

  // ---------------------------------------------------------------------------
  // 4. 播放器资产与 HTML 导出(验收标准 2:离线可播放;标准 4:资产随包分发)
  // ---------------------------------------------------------------------------

  test('assets/player.html 与包分发:读取模板并渲染自包含回放页', async () => {
    const templateUrl = new URL('../assets/player.html', import.meta.url)
    const template = await readFile(templateUrl, 'utf-8')
    assert(template.includes('asciinema'), '模板含播放器标识')
    assert(template.includes('__CAST_JSON__') && template.includes('__TITLE__'), '模板含占位符')

    const cast: CastFile = {
      version: 2, width: 80, height: 24, timestamp: castTimestamp(),
      title: '</script><b>x</b>', // 标题转义 + script 闭合安全
      events: [[0.5, 'o', 'line one\n'], [0.5, 'm', '点这里']],
    }
    const html = renderPlayerHtml(template, cast, cast.title ?? 'untitled')
    assert(!html.includes('__CAST_JSON__'), '导出页不含未替换占位符')
    assert(!html.includes('</script><b>'), 'JSON 内嵌做了 script 闭合转义(</ 已转义)')
    assert(html.includes('点这里'), 'marker 数据内嵌')
    assert(html.includes('line one'), '输出文本内嵌')
    assert(!html.includes('__TITLE__'), '标题占位符替换完成')

    // 内嵌 JSON 必须能被 JSON.parse 回读且合法
    const jsonText = ((html.match(/<script type="application\/json" id="cast-data">([\s\S]*?)<\/script>/) ?? [])[1] ?? 'null')
      .replace(/<\\\//g, '</')
    const embedded = JSON.parse(jsonText) as CastFile
    assertEq(embedded.version, 2, '内嵌 cast version=2')
    assertEq(validateCast(embedded).length, 0, '内嵌 cast 校验通过')
    assertEq(embedded.title, '</script><b>x</b>', '标题往返无损')

    // 播放器内嵌 JS 必须无语法错误(仅解析,不执行,无 DOM)
    const playerJs = ((html.match(/<script>([\s\S]*?)<\/script>/) ?? [])[1] ?? '')
    assert(playerJs.includes('loadCast'), '找到播放器脚本')
    new Function(playerJs) // SyntaxError 时与 throw 等价 → 测试失败
  })

  test('工具辅助:路径/文件名派生', () => {
    assertEq(htmlPathForCast('.casts/demo.cast'), '.casts/demo.html', 'html 与 cast 同目录')
    assertEq(sanitizeName('a/b c'), 'a-b-c', '录制名清理')
    assertEq(jsonForEmbed('</script>'), '"<\\/script>"', 'jsonForEmbed 防 script 闭合')
  })

  await runTests()

  console.log(`\n✅ 冒烟测试全部通过:${passed}/${tests.length} 项`)
}

await main()
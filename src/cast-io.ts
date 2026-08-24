/**
 * cast 文件的读写辅助:解析路径、写 .cast / 导出 .html、加载播放器模板。
 * 全部走注入的 ctx.fs(不直接碰 node:fs),遵守会话工作区语义。
 *
 * @module dsh-asciinema/cast-io
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { CastFile } from './cast-core.ts'

/** 会话 cwd(fs 相对路径的解析基准)。 */
export function sessionCwd(session: Session | undefined): string | undefined {
  return session?.header.cwd
}

/** 录制名 → 安全文件名(去路径分隔符与特殊字符)。 */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'rec' : cleaned
}

/** 解析会话工作区内的目标路径。 */
export async function resolveTarget(
  ctx: Context,
  session: Session | undefined,
  path: string,
  signal: AbortSignal,
): Promise<FsTarget> {
  const cwd = sessionCwd(session)
  return ctx.fs.resolve(path, cwd !== undefined ? { cwd, signal } : { signal })
}

export interface SaveCastResult {
  /** 相对会话工作区的路径,如 `.casts/demo.cast`。 */
  relPath: string
  /** 后端返回的绝对进程路径。 */
  absPath: string
}

/** 把 CastFile 序列化并写入 `<castsDir>/<name>.cast`(父目录自动创建)。 */
export async function saveCastFile(
  ctx: Context,
  session: Session | undefined,
  castsDir: string,
  name: string,
  cast: CastFile,
  signal: AbortSignal,
): Promise<SaveCastResult> {
  const fileName = `${sanitizeName(name)}.cast`
  const relPath = `${castsDir}/${fileName}`
  const target = await resolveTarget(ctx, session, relPath, signal)
  const content = JSON.stringify(cast)
  await ctx.fs.writeText(target, content, undefined, signal)
  return { relPath, absPath: ctx.fs.processPath(target) }
}

/** 读取并解析一个 .cast 文件文本。 */
export async function readCastText(ctx: Context, session: Session | undefined, path: string, signal: AbortSignal): Promise<string> {
  const target = await resolveTarget(ctx, session, path, signal)
  return ctx.fs.readText(target, signal)
}

/** 播放器内嵌页模板文件(package 内 assets/player.html)的绝对路径。 */
export function playerTemplatePath(): string | undefined {
  try {
    const url = new URL('../../assets/player.html', import.meta.url)
    return decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
}

/** 读取播放器模板;缺失时返回 null(调用方回退内嵌最小模板)。 */
export async function loadPlayerTemplate(ctx: Context, signal: AbortSignal): Promise<string | null> {
  const path = playerTemplatePath()
  if (path === undefined) return null
  try {
    const target = await ctx.fs.resolve(path, { signal })
    return ctx.fs.readText(target, signal)
  } catch {
    return null
  }
}

/**
 * 用模板 + 内嵌 cast JSON 生成自包含回放 HTML(离线可播:无任何外部请求)。
 * 占位符:__CAST_JSON__ / __TITLE__ / __CAST_URL__。
 */
export function renderPlayerHtml(template: string, cast: CastFile, title: string): string {
  const json = JSON.stringify(cast).replace(/<\//g, '<\\/')
  return template
    .replaceAll('__CAST_JSON__', json)
    .replaceAll('__TITLE__', escapeHtml(title))
    .replaceAll('__CAST_URL__', '')
}

/** HTML 文本转义(用于模板内嵌标题)。 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** .cast 路径 → 同目录下 .html 导出路径。 */
export function htmlPathForCast(relPath: string): string {
  const stripped = relPath.replace(/\.cast$/i, '')
  return `${stripped}.html`
}
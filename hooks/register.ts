import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'

// ---------------------------------------------------------------------------
// image-preview: inline image previews for Claude Code in Ghostty / kitty.
//
// - Every image Claude opens with the Read tool gets a preview under its row
//   (standalone rows and folded "Read N files" groups alike).
// - Images pasted into the prompt get thumbnails above it while you write.
// - /img <path>   opens any image in a pane (Esc closes it)
// - /img off|on   turns the inline and pasted previews off or on (remembered)
//
// Pictures go out through Claude Code's own `Image` element, which speaks the
// kitty graphics protocol where the terminal has it and draws the alt text
// everywhere else. That protocol takes PNG, so other formats are converted
// once with `sips` (built into macOS), ImageMagick or ffmpeg, and cached.
// ---------------------------------------------------------------------------

const PANE = 'image-preview'
// Sizing follows Grok Build (inline_media_reserved_rows): fill the width, cap the height
const MIN_ROWS = 4 // shortest inline preview, in terminal cells
const MAX_ROWS = 20 // tallest inline preview, in terminal cells
const INDENT = 8 // cells left of an inline preview (Claude Code's gutter + our padding)
const PAD = 5 // our padding: previews start under the row's text
const DEFAULT_CELL_ASPECT = 2 // a cell's height over its width when the terminal doesn't say (8x16 px)
const MAX_PNG_BYTES = 2 * 1024 * 1024 // what an Image element takes inline
const GROUP_LIMIT = 4 // previews drawn under one folded group of reads
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i
const THUMB_ROWS = 6 // tallest thumbnail of a pasted image above the prompt
const THUMB_LIMIT = 6 // thumbnails drawn above the prompt; the rest are counted
const THUMB_GAP = 2 // cells between thumbnails
const POLL_MS = 400 // how often the draft is checked for pasted images
// Claude Code writes a pasted image to <config>/projects/<project>/<session>/images/<n>.<ext>
const PASTE_EXTS = ['png', 'jpg', 'gif', 'webp']
const PASTE_TAG = /\[Image #(\d+)\]/g

// the images the draft in the prompt box refers to, drawn above it
const pasted = atom({ plugin: 'image-preview', key: 'pasted' } as const, [] as PastedImage[])

type Picture = { png: string; width: number; height: number }
type Preview = { ok: true; picture: Picture } | { ok: false; reason: string }

// path + mtime -> preview; module memory, rebuilt lazily after a reload
const cache = new Map<string, Promise<Preview>>()
let isInlineOn = true
// the picture fills its cells, so a wrong aspect squashes or stretches it
let cellAspect = DEFAULT_CELL_ASPECT
let measuredAt: number | undefined // viewport columns at the last measurement
let panePath: string | undefined
// session id -> its images folder, and "session:n" -> the file of [Image #n]
const imageDirs = new Map<string, string>()
const pastePaths = new Map<string, string>()
let poll: { cancel: () => void } | undefined // the timer that checks the draft

// ---------- small helpers (no $) ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Decodes just the first `n` bytes of a base64 string. */
function headBytes(b64: string, n: number): number[] {
  const out: number[] = []
  const chars = b64.slice(0, Math.ceil(n / 3) * 4 + 4)
  for (let i = 0; i + 3 < chars.length && out.length < n; i += 4) {
    const v = [0, 1, 2, 3].map(k => B64.indexOf(chars.charAt(i + k)))
    const [a = 0, b = 0, c = -1, d = -1] = v
    out.push(((a << 2) | (b >> 4)) & 255)
    if (c >= 0) out.push((((b & 15) << 4) | (c >> 2)) & 255)
    if (d >= 0) out.push((((c & 3) << 6) | d) & 255)
  }
  return out.slice(0, n)
}

/** Width and height from a PNG's IHDR chunk, or undefined if it isn't a PNG. */
function pngSize(b64: string): { width: number; height: number } | undefined {
  const b = headBytes(b64, 24)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || sig.some((s, i) => b[i] !== s)) return undefined
  const u32 = (o: number) =>
    (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)
  const width = u32(16)
  const height = u32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function decodedSize(b64: string): number {
  return Math.floor((b64.length * 3) / 4)
}

function asPicture(b64: string): Picture | undefined {
  const size = pngSize(b64)
  if (!size || decodedSize(b64) > MAX_PNG_BYTES) return undefined
  return { png: b64, ...size }
}

/** Cells for a picture: fills maxColumns, or maxRows when that would be too tall; keeps the aspect ratio. */
function cellsFor(p: Picture, maxColumns: number, maxRows: number): { columns: number; rows: number } {
  const clamp = (v: number, hi: number) => Math.max(1, Math.min(hi, 255, Math.round(v)))
  const columnsPerRow = (p.width / p.height) * cellAspect
  const rowsByWidth = Math.round(maxColumns / columnsPerRow)
  return rowsByWidth <= maxRows
    ? { columns: clamp(maxColumns, maxColumns), rows: clamp(rowsByWidth, maxRows) }
    : { columns: clamp(maxRows * columnsPerRow, maxColumns), rows: clamp(maxRows, maxRows) }
}

/**
 * Left padding that centers `columns` cells in the inline budget. Computed, like Grok's `pad_x`, rather
 * than left to flex centering: a folded group's container is only as wide as its content.
 */
function centerPad(columns: number, maxColumns: number): number {
  return PAD + Math.max(0, Math.floor((maxColumns - columns) / 2))
}

/** Inline preview budget for a terminal `columns` wide: full content width, height clamp(width / 2, 4, 20). */
function inlineBudget(columns: number | undefined): { maxColumns: number; maxRows: number } {
  const maxColumns = Math.max(MIN_ROWS, (columns ?? 80) - INDENT)
  return { maxColumns, maxRows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(maxColumns / 2))) }
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

function baseName(path: string): string {
  return path.split('/').pop() || path
}

/** The ids of the `[Image #n]` placeholders in a draft, in order, once each. */
function pastedIds(text: string): number[] {
  const ids: number[] = []
  for (const m of text.matchAll(PASTE_TAG)) {
    const id = Number(m[1])
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Claude Code's folder name for a project: every character outside [a-zA-Z0-9] becomes '-'. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function samePasted(a: readonly PastedImage[], b: readonly PastedImage[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i]?.id && p.path === b[i]?.path)
}

function readPath(input: unknown): string | undefined {
  const p = (input as { file_path?: unknown } | undefined)?.file_path
  return typeof p === 'string' && IMAGE_EXT.test(p) ? p : undefined
}

/** A PNG the Read tool already holds in its result, when there is one. */
function pictureFromReadOutput(output: unknown): Picture | undefined {
  const o = output as { type?: string; file?: { type?: string; base64?: string } } | undefined
  if (o?.type !== 'image' || o.file?.type !== 'image/png' || !o.file.base64) return undefined
  return asPicture(o.file.base64)
}

// ---------- helpers that reach outside (take $) ----------

async function resolvePath($: EngineInterface, raw: string): Promise<string> {
  let p = raw.trim().replace(/^["']|["']$/g, '')
  if (p === '~' || p.startsWith('~/')) {
    const home = (await $.env.get('HOME')) ?? ''
    p = home + p.slice(1)
  }
  if (!p.startsWith('/')) {
    const cwd: string = await $.session.cwd()
    p = cwd.replace(/\/$/, '') + '/' + p
  }
  return p
}

/** Turns any image file into a PNG Picture, converting once when needed. */
async function loadPicture($: EngineInterface, path: string): Promise<Preview> {
  let stat: Awaited<ReturnType<EngineInterface['fs']['stat']>>
  try {
    stat = await $.fs.stat(path)
  } catch {
    return { ok: false, reason: 'file not found' }
  }
  if (stat.kind !== 'file') return { ok: false, reason: 'not a file' }

  const key = path + ':' + stat.mtimeMs
  const hit = cache.get(key)
  if (hit) return hit

  const job = (async (): Promise<Preview> => {
    // A small enough PNG goes straight through.
    if (/\.png$/i.test(path) && stat.size <= MAX_PNG_BYTES) {
      const { base64 } = await $.fs.read(path, { as: 'bytes' })
      const pic = asPicture(base64)
      if (pic) return { ok: true, picture: pic }
    }

    // Everything else: convert to a PNG in the temp folder.
    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
    const out = `${tmp}/cc-image-preview-${hash(key)}.png`
    const attempts: string[][] = [
      ['sips', '-s', 'format', 'png', path, '--out', out],
      ['magick', path + '[0]', '-resize', '1600x1600>', out],
      ['convert', path + '[0]', '-resize', '1600x1600>', out],
      ['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", out],
    ]
    let converted = false
    for (const argv of attempts) {
      try {
        const run = await $.process.run(argv, { timeoutMs: 20000 })
        if (run.exitCode === 0 && (await $.fs.exists(out))) {
          converted = true
          break
        }
      } catch {
        // that tool isn't installed; try the next one
      }
    }
    if (!converted) {
      return { ok: false, reason: 'no converter found (macOS has sips; elsewhere install ImageMagick)' }
    }

    // Still too big for inline? Shrink it.
    const outStat = await $.fs.stat(out)
    if (outStat.size > MAX_PNG_BYTES) {
      try {
        await $.process.run(['sips', '-Z', '1200', out], { timeoutMs: 20000 })
      } catch {
        try {
          await $.process.run(['magick', out, '-resize', '1200x1200>', out], { timeoutMs: 20000 })
        } catch {
          // keep what we have; asPicture below reports it
        }
      }
    }

    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    const pic = asPicture(base64)
    return pic ? { ok: true, picture: pic } : { ok: false, reason: 'image too large to preview' }
  })().catch((err: unknown): Preview => ({ ok: false, reason: String(err instanceof Error ? err.message : err) }))

  cache.set(key, job)
  return job
}

async function previewFor($: EngineInterface, path: string, output: unknown): Promise<Preview> {
  const pic = pictureFromReadOutput(output)
  if (pic) return { ok: true, picture: pic }
  return loadPicture($, path)
}

/** The folder this session's pasted images are written to, or undefined when there is none yet. */
async function pasteDir($: EngineInterface, session: string): Promise<string | undefined> {
  if (imageDirs.get(session)) return imageDirs.get(session)
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) || ((await $.env.get('HOME')) ?? '') + '/.claude').replace(/\/$/, '')
  const projects = config + '/projects'
  const guess = `${projects}/${projectSlug(await $.session.cwd())}/${session}/images`
  let dir: string | undefined
  if (await $.fs.exists(guess)) {
    dir = guess
  } else {
    // a long or moved project path is named differently: look for the session's folder
    try {
      for (const entry of await $.fs.list(projects)) {
        const candidate = `${projects}/${entry.name}/${session}/images`
        if (entry.kind === 'dir' && (await $.fs.exists(candidate))) {
          dir = candidate
          break
        }
      }
    } catch {
      // no projects folder
    }
  }
  // remember a hit only: the folder appears with the session's first paste
  if (dir) imageDirs.set(session, dir)
  return dir
}

/** The file Claude Code wrote for `[Image #id]`, once it has. */
async function pastePath($: EngineInterface, session: string, id: number): Promise<string | undefined> {
  const key = `${session}:${id}`
  const known = pastePaths.get(key)
  if (known) return known
  const dir = await pasteDir($, session)
  if (!dir) return undefined
  for (const ext of PASTE_EXTS) {
    const path = `${dir}/${id}.${ext}`
    if (await $.fs.exists(path)) {
      pastePaths.set(key, path)
      return path
    }
  }
  return undefined
}

/** The draft in the prompt box; '' where there is none. */
async function draftText($: EngineInterface): Promise<string> {
  try {
    return (await $.prompt.read()).text
  } catch {
    return ''
  }
}

/** Points the band above the prompt at the images `draft` refers to. */
async function syncPasted($: EngineInterface, draft: string): Promise<void> {
  const ids = isInlineOn ? pastedIds(draft) : []
  const found: PastedImage[] = []
  if (ids.length > 0) {
    const session = await $.session.id()
    for (const id of ids) {
      const path = await pastePath($, session, id)
      if (path) found.push({ id, path })
    }
  }
  if (!samePasted(found, await read($, pasted))) await update($, pasted, () => found)
}

// Children have no controlling tty, so walk up to Claude Code's process and ask
// its tty for the window's pixel size (TIOCGWINSZ), the way Grok Build does.
const MEASURE_CELL = `
import fcntl, os, struct, subprocess, termios
pid = os.getppid()
while pid > 1:
    tty, ppid = (subprocess.run(['ps', '-o', 'tty=,ppid=', '-p', str(pid)], capture_output=True, text=True).stdout.split() + ['?', '0'])[:2]
    if tty not in ('?', '??'):
        fd = os.open('/dev/' + tty, os.O_RDONLY | os.O_NOCTTY)
        print(*struct.unpack('HHHH', fcntl.ioctl(fd, termios.TIOCGWINSZ, bytes(8))))
        break
    pid = int(ppid)
`

/** Cell height over width from the terminal's pixel size, or undefined when it can't tell. */
async function measureCellAspect($: EngineInterface): Promise<number | undefined> {
  try {
    const run = await $.process.run(['python3', '-c', MEASURE_CELL], { timeoutMs: 5000 })
    const [rows = 0, columns = 0, width = 0, height = 0] = run.stdout.trim().split(/\s+/).map(Number)
    if (!rows || !columns || !width || !height) return undefined
    const aspect = height / rows / (width / columns)
    // real monospace cells live in this band; outside it the report is bogus (tmux, ssh)
    return aspect >= 1.25 && aspect <= 3.4 ? aspect : undefined
  } catch {
    return undefined
  }
}

/**
 * Measures the cell aspect again when the viewport's width changed since the last time: a font
 * zoom always changes the column count, and fonts snap to whole pixels, so the ratio drifts.
 * Concurrent renders keep the old value; a changed result redraws them.
 */
async function syncCellAspect($: EngineInterface, columns: number | undefined): Promise<void> {
  if (columns === undefined || columns === measuredAt) return
  measuredAt = columns
  const measured = await measureCellAspect($)
  if (measured === undefined || Math.abs(measured - cellAspect) < 0.01) return
  cellAspect = measured
  $.ui.invalidate('ui.render')
}

// ---------- the mod ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'img',
      description: 'Preview an image in a pane; /img on|off toggles inline previews',
      argumentHint: '<path> | on | off',
    })
    const saved = await $.store.get('inline')
    if (typeof saved === 'boolean') isInlineOn = saved
    // A paste reaches the draft by more than one path, so the draft is also checked on a timer
    let isSyncing = false
    poll?.cancel()
    poll = $.clock.every(POLL_MS, async () => {
      if (isSyncing) return
      isSyncing = true
      try {
        await syncPasted($, await draftText($))
      } finally {
        isSyncing = false
      }
    })
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await syncPasted($, box.text)
    return box
  })

  // The draft leaves the box when it's sent
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await update($, pasted, () => [])
    return result
  })

  on('command.run', { command: 'img' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'on' || arg === 'off') {
      isInlineOn = arg === 'on'
      await $.store.set('inline', isInlineOn)
      await syncPasted($, await draftText($))
      $.ui.invalidate('ui.render')
      return { text: `Inline image previews ${isInlineOn ? 'on' : 'off'}.` }
    }

    if (!arg) {
      return {
        text:
          `Inline previews are ${isInlineOn ? 'on' : 'off'}. ` +
          'Usage: /img <path> to open an image, /img on|off to toggle inline and pasted previews.',
      }
    }

    const path = await resolvePath($, arg)
    const preview = await loadPicture($, path)
    if (!preview.ok) return { text: `Can't preview ${path}: ${preview.reason}` }

    panePath = path
    await $.ui.open({ id: PANE, title: baseName(path), focus: true, closeOnEscape: true })
    $.ui.invalidate('ui.render')
    return {}
  })

  // The pane /img opens.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.component !== 'Pane') return next(e)
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return Text({ dimColor: true, children: ['Image previews need the terminal (Ghostty or kitty).'] })
    }
    await syncCellAspect($, e.viewport?.columns)
    const { Box, Text, Image } = $.ui.resolve(e)
    if (!panePath) return Text({ dimColor: true, children: ['Run /img <path> to show an image here.'] })

    const preview = await loadPicture($, panePath)
    if (!preview.ok) return Text({ color: 'red', children: [`${panePath}: ${preview.reason}`] })

    const p = preview.picture
    const width = Math.max(8, e.props.bodyColumns - 2)
    const height =
      e.props.placement === 'dock' ? Math.max(4, e.props.scroll.bodyRows - 2) : MAX_ROWS * 2
    const size = cellsFor(p, width, height)
    return Box({
      flexDirection: 'column',
      children: [
        Image({ key: 'picture', source: { png: p.png }, ...size, alt: baseName(panePath) }),
        Text({ dimColor: true, wrap: 'truncate-middle', children: [`${panePath} · ${p.width}×${p.height}`] }),
      ],
    })
  })

  // A standalone Read row, or one row of an expanded group.
  on('ui.render', { component: 'ToolUse', props: { tool: 'Read' } }, async ($, e, next) => {
    if (e.component !== 'ToolUse' || e.surface !== 'terminal' || !isInlineOn) return next(e)
    const path = readPath(e.props.input)
    const { isRunning, isErrored, isInterrupted, output } = e.props
    if (!path || isRunning || isErrored || isInterrupted) return next(e)

    const { Box, Text, Image } = $.ui.resolve(e)
    const row = await next(e)
    const preview = await previewFor($, path, output)
    await syncCellAspect($, e.viewport?.columns)
    const { maxColumns, maxRows } = inlineBudget(e.viewport?.columns)

    if (!preview.ok) {
      const reason = Text({ dimColor: true, children: [`no preview: ${preview.reason}`] })
      return Box({ flexDirection: 'column', children: [row, Box({ paddingLeft: PAD, children: [reason] })] })
    }
    const size = cellsFor(preview.picture, maxColumns, maxRows)
    const below = Box({
      paddingLeft: centerPad(size.columns, maxColumns),
      children: [Image({ source: { png: preview.picture.png }, ...size, alt: baseName(path) })],
    })

    return Box({ flexDirection: 'column', children: [row, below] })
  })

  // A folded "Read N files" line: previews of its images under it.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.component !== 'ToolGroup' || e.surface !== 'terminal' || !isInlineOn || e.props.isExpanded) return next(e)
    const images = e.props.calls
      .filter(c => c.tool === 'Read' && !c.isRunning && !c.isErrored && !c.isInterrupted && readPath(c.input))
      .slice(-GROUP_LIMIT)
    if (images.length === 0) return next(e)

    const { Box, Text, Image } = $.ui.resolve(e)
    const row = await next(e)
    await syncCellAspect($, e.viewport?.columns)
    const { maxColumns, maxRows } = inlineBudget(e.viewport?.columns)

    const previews = []
    for (const call of images) {
      const path = readPath(call.input) as string
      const preview = await previewFor($, path, call.output)
      const label = Text({ dimColor: true, children: [baseName(path)] })
      if (!preview.ok) {
        previews.push(Box({ flexDirection: 'column', paddingLeft: PAD, children: [label, Text({ dimColor: true, children: [`no preview: ${preview.reason}`] })] }))
        continue
      }
      // the name sits over the picture's left edge
      const size = cellsFor(preview.picture, maxColumns, maxRows)
      previews.push(
        Box({
          flexDirection: 'column',
          paddingLeft: centerPad(size.columns, maxColumns),
          children: [label, Image({ source: { png: preview.picture.png }, ...size, alt: baseName(path) })],
        }),
      )
    }

    return Box({ flexDirection: 'column', children: [row, ...previews] })
  })

  // Thumbnails of the images pasted into the draft, above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.component !== 'AbovePrompt' || e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const images = await read($, pasted)
    if (!isInlineOn || images.length === 0) return next(e)

    const { Box, Text, Image } = $.ui.resolve(e)
    await syncCellAspect($, e.viewport?.columns)
    const shown = images.slice(0, THUMB_LIMIT)
    const rows = Math.max(2, Math.min(THUMB_ROWS, e.props.maxRows - 2))
    const columns = Math.max(4, Math.floor((e.props.bodyColumns - 2 - THUMB_GAP * (shown.length - 1)) / shown.length))

    const thumbs = []
    for (const { id, path } of shown) {
      const tag = `[Image #${id}]`
      const preview = await loadPicture($, path)
      const picture = preview.ok
        ? Image({ source: { png: preview.picture.png }, ...cellsFor(preview.picture, columns, rows), alt: tag })
        : Text({ dimColor: true, children: [`no preview: ${preview.reason}`] })
      thumbs.push(
        Box({
          key: `pasted-${id}`,
          flexDirection: 'column',
          children: [picture, Text({ dimColor: true, wrap: 'truncate-end', children: [tag] })],
        }),
      )
    }
    if (images.length > shown.length) {
      thumbs.push(Text({ dimColor: true, children: [`+${images.length - shown.length} more`] }))
    }

    const band = Box({ key: 'pasted', flexDirection: 'row', columnGap: THUMB_GAP, paddingLeft: 2, children: thumbs })
    const below = await next(e)
    return below ? Box({ flexDirection: 'column', children: [band, below] }) : band
  })
}

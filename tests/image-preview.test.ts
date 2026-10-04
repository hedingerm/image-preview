import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

// Stand in for Claude Code's own drawing of a row and for its store
function engine(on: On) {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine row'] })
  })
  mock.store(on)
}

// A 64x32 red PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAWElEQVR4nO3QMREAMBDDsPAn/YWhoR60+7zb7mfTAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA8g8vDiJft7OwAAAABJRU5ErkJggg=='

const readRow = (file_path: string, output: unknown) => ({
  tool_use_id: 'toolu_1',
  tool: 'Read',
  input: { file_path },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output,
})
const pngOutput = { type: 'image', file: { base64: PNG, type: 'image/png', originalSize: 120 } }
const VIEW = { columns: 120, rows: 40, isFullscreen: false }

// `/img <args>` typed at the prompt
const typed = (args: string) => ({
  command: 'img', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 },
})

test('a Read of a PNG gets an inline preview in the terminal', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolUse',
    props: readRow('/tmp/cat.png', pngOutput) as any, viewport: VIEW,
  })
  const img = await ui.find({ type: 'Image' })
  expect(img).toBeDefined()
  expect((img?.props.source as { png: string }).png).toBe(PNG)
  // Grok-style budget at 120 columns: 112 wide, 20 tall; 2:1 at the default 2:1 cell hits the height cap
  expect(img?.props.columns).toBe(80)
  expect(img?.props.rows).toBe(20)
  expect(img?.props.alt).toBe('cat.png')
})

test('non-image reads and the desktop app are left alone', async ($, on) => {
  engine(on)
  const text = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolUse',
    props: readRow('/tmp/notes.md', { type: 'text' }) as any, viewport: VIEW,
  })
  expect(await text.find({ type: 'Image' })).toBeUndefined()
  const desk = await $.ui.mount({
    plugin: 'image-preview', surface: 'desktop', component: 'ToolUse',
    props: readRow('/tmp/cat.png', pngOutput) as any, viewport: VIEW,
  })
  expect(await desk.find({ type: 'Image' })).toBeUndefined()
})

test('/img off turns inline previews off, /img on back on', async ($, on) => {
  engine(on)
  const off = await $.command.run(typed('off'))
  expect(off.text).toContain('off')
  const a = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolUse',
    props: readRow('/tmp/cat.png', pngOutput) as any, viewport: VIEW,
  })
  expect(await a.find({ type: 'Image' })).toBeUndefined()
  await $.command.run(typed('on'))
  const b = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolUse',
    props: readRow('/tmp/cat.png', pngOutput) as any, viewport: VIEW,
  })
  expect(await b.find({ type: 'Image' })).toBeDefined()
})

test('a JPEG is converted once and previewed', async ($, on) => {
  engine(on)
  let runs = 0
  on('fs.stat', () => ({ value: { kind: 'file', size: 5000, mtimeMs: 1, isLink: false } }))
  on('fs.exists', () => ({ value: true }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'python3') runs += 1
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))
  const jpg = { type: 'image', file: { base64: '/9j/', type: 'image/jpeg', originalSize: 5000 } }
  for (let i = 0; i < 2; i++) {
    const ui = await $.ui.mount({
      plugin: 'image-preview', surface: 'terminal', component: 'ToolUse',
      props: readRow('/tmp/photo.jpg', jpg) as any, viewport: VIEW,
    })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
  }
  expect(runs).toBe(1) // sips succeeded on the first try, second render hit the cache
})

test('a folded group of reads shows its images', async ($, on) => {
  engine(on)
  const call = (p: string, output: unknown) => ({ tool: 'Read', input: { file_path: p }, isRunning: false, isErrored: false, isInterrupted: false, output })
  const ui = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolGroup',
    props: { calls: [call('/a/README.md', { type: 'text' }), call('/a/logo.png', pngOutput)], isActive: false, isExpanded: false } as any,
    viewport: VIEW,
  })
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'logo.png' })).toBeDefined()
})

test('/img <path> opens a pane with the picture', async ($, on) => {
  engine(on)
  let opened = ''
  on('fs.stat', () => ({ value: { kind: 'file', size: 200, mtimeMs: 2, isLink: false } }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('ui.open', (_$, e) => {
    opened = e.id
    return { value: { isPlaced: true } }
  })
  const run = await $.command.run(typed('/Users/you/shot.png'))
  expect(run.text).toBeUndefined()
  expect(opened).toBe('image-preview')
  const ui = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'Pane', requestId: 'image-preview',
    props: { title: 'shot.png', isFocused: true, bodyColumns: 50, placement: 'inline', scroll: { bodyRows: 20 } } as any,
    viewport: VIEW,
  })
  const img = await ui.find({ type: 'Image' })
  expect(img?.props.alt).toBe('shot.png')
  expect(await ui.find({ type: 'Text', text: /64×32/ })).toBeDefined()
})

test('/img on a missing file says so', async ($, on) => {
  engine(on)
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  const run = await $.command.run(typed('/nope.png'))
  expect(run.text).toContain('file not found')
})

// The terminal's answer to the cell measurement: `rows cols xpixel ypixel`, changeable mid-test
function terminal(on: On, winsize: { now: string }) {
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'python3' ? winsize.now + '\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
}

const mountCat = ($: Parameters<TestBody>[0], columns: number) =>
  $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolUse',
    props: readRow('/tmp/cat.png', pngOutput) as any, viewport: { ...VIEW, columns },
  })

test('the cell aspect is measured from the terminal and previews are centered', async ($, on) => {
  engine(on)
  // Ghostty at 204x64 cells over 1633x1281 px: cells are 2.5 times taller than wide
  terminal(on, { now: '64 204 1633 1281' })
  const ui = await mountCat($, 120)
  const img = await ui.find({ type: 'Image' })
  // 2:1 picture at 2.5: 5 columns per row, so 20 rows hold 100 columns
  expect(img?.props.columns).toBe(100)
  expect(img?.props.rows).toBe(20)
  // centered in the 112-column budget: 5 + (112 - 100) / 2
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(b => b.props.paddingLeft === 11)).toBe(true)
})

test('a font zoom mid-session is measured again', async ($, on) => {
  engine(on)
  const winsize = { now: '64 204 1633 1281' } // 8x20 px cells: 2.5
  terminal(on, winsize)
  expect((await (await mountCat($, 120)).find({ type: 'Image' }))?.props.columns).toBe(100)
  winsize.now = '58 181 1633 1281' // zoomed in, 9x22 px cells: 2.44
  // same width: no new measurement, the old aspect holds
  expect((await (await mountCat($, 120)).find({ type: 'Image' }))?.props.columns).toBe(100)
  // the zoom changed the column count: measured again, 20 rows * 4.89 columns per row
  expect((await (await mountCat($, 110)).find({ type: 'Image' }))?.props.columns).toBe(98)
})

test('a bogus pixel report keeps the default aspect', async ($, on) => {
  engine(on)
  terminal(on, { now: '64 204 1633 200' })
  expect((await (await mountCat($, 120)).find({ type: 'Image' }))?.props.columns).toBe(80)
})

test('a folded group centers its previews too', async ($, on) => {
  engine(on)
  terminal(on, { now: '64 204 1633 1281' })
  const call = (p: string, output: unknown) => ({ tool: 'Read', input: { file_path: p }, isRunning: false, isErrored: false, isInterrupted: false, output })
  const ui = await $.ui.mount({
    plugin: 'image-preview', surface: 'terminal', component: 'ToolGroup',
    props: { calls: [call('/a/logo.png', pngOutput)], isActive: false, isExpanded: false } as any,
    viewport: VIEW,
  })
  expect((await ui.find({ type: 'Image' }))?.props.columns).toBe(100)
  // the padding is computed, so it holds however wide the engine makes the group's container
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(b => b.props.paddingLeft === 11)).toBe(true)
  expect(boxes.some(b => b.props.alignItems === 'center' || b.props.justifyContent === 'center')).toBe(false)
})

// A session whose clipboard holds `clip` (what the mod's clipboard script prints) and whose draft is `draft`
type Clip = { files?: string[]; png?: boolean }
function pasteSession(on: On, session: string, clip: { now: Clip }, draft: { text: string }) {
  on('env.get', (_$, e) => ({ value: e.name === 'TMPDIR' ? '/tmp' : undefined }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: session }))
  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('process.run', (_$, e) => {
    const out = e.argv[e.argv.length - 1] ?? ''
    const { files, png } = clip.now
    const stdout = e.argv[0] === 'osascript' ? JSON.stringify(files ? { files } : png ? { png: out } : {}) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 200, mtimeMs: 3, isLink: false } }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
}

const startSession = ($: Parameters<TestBody>[0]) =>
  $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

const mountBand = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({
    plugin: 'image-preview', surface, component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { bodyRows: 20 }, view: {} } as any,
    viewport: VIEW,
  })

const thumbTags = async ($: Parameters<TestBody>[0]) =>
  (await (await mountBand($)).findAll({ type: 'Image' })).map(t => t.props.alt)

test('images pasted into the draft get thumbnails above the prompt', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const clip: { now: Clip } = { now: {} }
  const draft = { text: '' }
  pasteSession(on, 'sess-paste', clip, draft)
  await startSession($)

  await clock.advance(500)
  expect(await thumbTags($)).toEqual([])

  clip.now = { png: true }
  draft.text = 'what is wrong here [Image #1]'
  await clock.advance(500)
  draft.text += ' and [Image #2]'
  await clock.advance(500)
  const thumbs = await (await mountBand($)).findAll({ type: 'Image' })
  expect(thumbs.map(t => t.props.alt)).toEqual(['[Image #1]', '[Image #2]'])
  // 2:1 picture in a thumbnail at most 6 rows tall
  expect(thumbs[0]?.props.rows).toBe(6)
  expect(thumbs[0]?.props.columns).toBe(24)

  // deleting the placeholder removes the thumbnail
  draft.text = 'what is wrong here [Image #2]'
  await clock.advance(500)
  expect(await thumbTags($)).toEqual(['[Image #2]'])
})

test('several copied files map onto their placeholders; one picture goes to the newest only', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  // a text file copied along isn't one of the pasted images
  const clip: { now: Clip } = { now: { files: ['/pics/a.png', '/pics/notes.txt', '/pics/b.png'] } }
  const draft = { text: '' }
  pasteSession(on, 'sess-files', clip, draft)
  await startSession($)

  draft.text = '[Image #1] [Image #2]'
  await clock.advance(500)
  expect(await thumbTags($)).toEqual(['[Image #1]', '[Image #2]'])

  // two placeholders at once but one picture: no guessing for the older one
  clip.now = { png: true }
  draft.text += ' [Image #3] [Image #4]'
  await clock.advance(500)
  expect(await thumbTags($)).toEqual(['[Image #1]', '[Image #2]', '[Image #4]'])
})

test('a resumed draft and an empty clipboard get no thumbnails; submit and /img off clear them', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const clip: { now: Clip } = { now: { png: true } }
  const draft = { text: 'from before [Image #1]' }
  pasteSession(on, 'sess-resume', clip, draft)
  await startSession($)

  // pasted before the session started: the clipboard holds something else by now
  await clock.advance(500)
  expect(await thumbTags($)).toEqual([])

  // a paste with nothing on the clipboard isn't read again later
  clip.now = {}
  draft.text += ' [Image #2]'
  await clock.advance(500)
  clip.now = { png: true }
  await clock.advance(500)
  expect(await thumbTags($)).toEqual([])

  draft.text += ' [Image #3]'
  await clock.advance(500)
  expect(await thumbTags($)).toEqual(['[Image #3]'])
  // the desktop app shows its own
  expect(await (await mountBand($, 'desktop')).find({ type: 'Image' })).toBeUndefined()

  await $.command.run(typed('off'))
  expect(await thumbTags($)).toEqual([])
  await $.command.run(typed('on'))
  expect(await thumbTags($)).toEqual(['[Image #3]'])

  await $.prompt.submit({ text: draft.text, wait: false, origin: { kind: 'composer' } })
  draft.text = ''
  expect(await thumbTags($)).toEqual([])
})

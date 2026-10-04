# image-preview

Inline image previews for Claude Code in Ghostty and kitty. When Claude reads an image, you see it right in the transcript instead of just a file name, and images you paste show up as thumbnails above the prompt while you're still writing.

- **Inline:** every image Claude opens with the Read tool gets a preview under its row, including folded "Read N files" groups.
- **Pasted:** every image you paste (or drag) into the prompt gets a thumbnail above the input box, labeled with its `[Image #N]` placeholder. Delete the placeholder and the thumbnail goes; send the prompt and the row clears.
- **`/img <path>`** opens any image in a pane. Relative paths and `~` work, and Esc closes it.
- **`/img off` / `/img on`** turns inline and pasted previews off or on. The setting is remembered across sessions.

## Install

Requires Claude Code 2.1.287 or later, since mods are still early access.

```
/plugin marketplace add hedingerm/claude-plugins
/plugin install image-preview@hedingerm
```

It's listed in [hedingerm/claude-plugins](https://github.com/hedingerm/claude-plugins), my marketplace for Claude Code plugins.

Start a new session, then check it loaded with `/plugin` (Installed tab), or just type `/img`.

### Multiplexers

Claude Code asks the terminal at startup whether it draws pictures. Inside a multiplexer it often concludes it can't and shows the dim alt text (`[Image #N]`, the file name) instead.

- **herdr** passes pictures through (`terminal.kitty_graphics`, on by default), but Claude Code's check misses it. Force pictures on in `~/.claude/settings.json`, then restart Claude Code:

  ```json
  { "env": { "CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1" } }
  ```

  Only do this if every terminal you run Claude Code in draws pictures; elsewhere you'd get garbage instead of alt text.
- **tmux / screen:** Claude Code turns pictures off inside them. Run it outside to see previews.

## How it works

**Drawing:** pictures go through Claude Code's own `Image` element, which speaks the kitty graphics protocol. Terminals without it show the file name instead, so nothing breaks.

**Formats:** PNGs go straight through. JPEG, GIF, WebP, HEIC, TIFF and friends are converted to PNG once with `sips` (built into macOS), falling back to ImageMagick or ffmpeg, and cached in `$TMPDIR`.

**Sizing:** a preview fills the available width and is at most `clamp(width / 2, 4, 20)` rows tall, centered under its row. Several images in one group each get the full size.

**Pasted images:** Claude Code keeps a pasted image in memory only, so the mod watches the draft for new `[Image #N]` placeholders (on every edit and on a 400 ms timer) and saves the clipboard's picture for it to the temp folder: with `osascript` on macOS, `wl-paste` or `xclip` on Linux. Files copied in Finder map onto the new placeholders one each. When several placeholders appear at once but the clipboard holds one picture, only the newest gets it, and placeholders already in a resumed draft get none. Thumbnails are at most `THUMB_ROWS` rows tall and `THUMB_LIMIT` side by side.

**Proportions:** terminal cells aren't square, so the mod measures their real shape from the window's pixel size (`TIOCGWINSZ` on Claude Code's tty). It measures on the first preview and again whenever the column count changes, for example after a font zoom. This uses `python3`; without it, or when the terminal reports nonsense (tmux, ssh), the mod assumes cells twice as tall as wide.

## Tune

Constants at the top of `hooks/register.ts`: `MIN_ROWS`, `MAX_ROWS`, `INDENT`, `DEFAULT_CELL_ASPECT`, `GROUP_LIMIT`, `THUMB_ROWS`, `THUMB_LIMIT` and `POLL_MS`.

## Develop

```bash
git clone https://github.com/hedingerm/image-preview
claude --plugin-dir ./image-preview      # edits hot-reload while this session runs
claude plugin validate ./image-preview
claude plugin test ./image-preview
```

## Credits

The sizing and cell measurement follow the approach of [Grok Build](https://github.com/xai-org/grok-build)'s inline media (Apache-2.0), reimplemented here in TypeScript.

## License

MIT

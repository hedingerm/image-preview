# image-preview

Inline image previews for Claude Code in Ghostty and kitty. When Claude reads an image, you see it right in the transcript instead of just a file name.

- **Inline:** every image Claude opens with the Read tool gets a preview under its row, including folded "Read N files" groups.
- **`/img <path>`** opens any image in a pane. Relative paths and `~` work, and Esc closes it.
- **`/img off` / `/img on`** turns inline previews off or on. The setting is remembered across sessions.

## Install

Requires Claude Code 2.1.287 or later, since mods are still early access.

```
/plugin marketplace add hedingerm/image-preview
/plugin install image-preview@image-preview
```

Start a new session, then check it loaded with `/plugin` (Installed tab), or just type `/img`.

## How it works

**Drawing:** pictures go through Claude Code's own `Image` element, which speaks the kitty graphics protocol. Terminals without it show the file name instead, so nothing breaks.

**Formats:** PNGs go straight through. JPEG, GIF, WebP, HEIC, TIFF and friends are converted to PNG once with `sips` (built into macOS), falling back to ImageMagick or ffmpeg, and cached in `$TMPDIR`.

**Sizing:** a preview fills the available width and is at most `clamp(width / 2, 4, 20)` rows tall, centered under its row. Several images in one group each get the full size.

**Proportions:** terminal cells aren't square, so the mod measures their real shape from the window's pixel size (`TIOCGWINSZ` on Claude Code's tty). It measures on the first preview and again whenever the column count changes, for example after a font zoom. This uses `python3`; without it, or when the terminal reports nonsense (tmux, ssh), the mod assumes cells twice as tall as wide.

## Tune

Constants at the top of `hooks/register.ts`: `MIN_ROWS`, `MAX_ROWS`, `INDENT`, `DEFAULT_CELL_ASPECT` and `GROUP_LIMIT`.

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

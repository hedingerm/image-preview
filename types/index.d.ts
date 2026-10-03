/** An image pasted into the prompt draft: its `[Image #id]` placeholder and the file Claude Code wrote for it. */
export type PastedImage = { id: number; path: string }

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { pasted: PastedImage[] }
  }
}

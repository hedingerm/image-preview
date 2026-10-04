/** An image pasted into the prompt draft: its `[Image #id]` placeholder and the mod's copy of its picture. */
export type PastedImage = { id: number; path: string }

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { pasted: PastedImage[] }
  }
}

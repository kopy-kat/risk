import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `.claude/worktrees/*` holds full copies of this repo, tsconfig.json and
    // mock/ included. Watching them means creating a worktree reads as "the
    // config changed", and the answer to that is a full page reload — which
    // throws away the game in progress. Nothing served comes from there.
    watch: { ignored: ['**/.claude/**'] },
  },
})

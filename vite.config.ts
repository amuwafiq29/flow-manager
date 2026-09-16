import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { sourcemap: false },
  define: {
    __FM_BUILD_ID__: JSON.stringify(process.env.FM_BUILD_ID || "dev"),
  },
})

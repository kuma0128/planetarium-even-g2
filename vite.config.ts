import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    // Browser-test traces contain HTML; saving them must not reload an active app.
    watch: { ignored: ["**/artifacts/**"] },
  },
});

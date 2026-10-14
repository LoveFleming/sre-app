import { defineConfig } from "vite";

// 預設埠 5175（PAAW=5173、learning-space=5174 錯開）
export default defineConfig({
  server: { port: 5175, host: "0.0.0.0" },
  preview: { port: 5175, host: "0.0.0.0" },
});

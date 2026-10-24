import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'extension',
  publicDir: 'extension/public',
  imports: false,
  manifest: {
    name: 'DeepDock',
    description: 'An agent harness for DeepSeek: local tools, durable tasks, permissions, and handoff.',
    permissions: ['storage', 'alarms'],
    host_permissions: ['http://127.0.0.1/*'],
    minimum_chrome_version: '120',
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
});

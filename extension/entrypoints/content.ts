import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createHarness } from '../src/harness.js';
import '../src/ui/panel.css';

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const harness = createHarness({
      browser,
      scheduleInterval: (callback: () => void, ms: number) => ctx.setInterval(callback, ms),
    });
    ctx.onInvalidated(() => { void harness.dispose(); });
    void harness.init().catch((error: unknown) => console.error('DeepDock initialization failed:', error));
  },
});

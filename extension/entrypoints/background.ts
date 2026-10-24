import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { startBackground } from '../src/background.js';

export default defineBackground(() => {
  startBackground(browser);
});

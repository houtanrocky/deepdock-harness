'use strict';

const installButtons = document.querySelectorAll('[data-install]');
installButtons.forEach((button) => {
  button.addEventListener('click', () => {
    installButtons.forEach((candidate) => {
      const selected = candidate === button;
      candidate.classList.toggle('active', selected);
      candidate.setAttribute('aria-pressed', String(selected));
      document.getElementById('install-' + candidate.dataset.install).hidden = !selected;
    });
    document.querySelector('.copy-status').textContent = '';
  });
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).textContent;
    const status = document.querySelector('.copy-status');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      status.textContent = 'Setup commands copied.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(button.dataset.copy));
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Commands selected. Press Ctrl+C or Command+C to copy.';
    }
  });
});

const playButton = document.querySelector('.demo-play');
const steps = [...document.querySelectorAll('.demo-step')];
const result = document.querySelector('.demo-result');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

playButton.addEventListener('click', async () => {
  playButton.disabled = true;
  playButton.textContent = 'Walking through the task…';
  result.textContent = 'Reading app.js before making a change.';
  for (const step of steps) {
    step.classList.remove('done', 'running');
    step.querySelector('.step-status').textContent = 'READY';
  }
  const messages = ['Current greeting found. Preparing a focused edit.', 'Greeting changed to Welcome. Checking the result.', 'Done. The greeting check passed.'];
  for (const [index, step] of steps.entries()) {
    step.classList.add('running');
    step.querySelector('.step-status').textContent = 'RUNNING';
    await delay(reducedMotion ? 0 : 700);
    step.classList.remove('running');
    step.classList.add('done');
    step.querySelector('.step-status').textContent = 'DONE';
    result.textContent = messages[index];
  }
  playButton.disabled = false;
  playButton.textContent = '↻ Replay the walkthrough';
});

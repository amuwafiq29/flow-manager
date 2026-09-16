/**
 * Flow project page selectors — updated for 2026 redesign.
 *
 * Feb 2026: Flow moved from labs.google/fx/tools/flow to flow.google,
 * with a redesigned prompt bar (image-first, Nano Banana built-in),
 * asset grid, Agent mode, and localized URLs (/fx/<locale>/tools/flow).
 *
 * Class hashes change on every deploy — NEVER rely on hashed classes.
 * Prefer role / data attrs / aria-labels / icon text, with positional
 * fallbacks (lowest visible element = prompt bar) in content.js.
 */
globalThis.FLOW_BATCH_DEFAULT_SELECTORS = {
  promptInput: [
    // Slate (classic + redesign)
    'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
    'div[contenteditable="true"][data-slate-editor="true"]',
    // Generic contenteditable textbox (redesign fallback)
    'div[contenteditable="true"][aria-multiline="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div[contenteditable="true"][aria-label*="create" i]',
    'div[contenteditable="true"][aria-label*="describe" i]',
    'div[contenteditable="true"][aria-placeholder*="prompt" i]',
    // Native inputs (possible redesign / agent panel)
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea[placeholder*="describe" i]',
    'textarea[placeholder*="create" i]',
    '[data-testid*="prompt" i]',
    '[data-test*="prompt" i]',
    'textarea',
  ],

  submitButton: [
    // Classic labels
    'button[aria-label="Create"]',
    'button[aria-label*="Create" i]',
    'button[aria-label*="Buat" i]',
    // Redesign labels (image-first UI: Generate / Create image / Send)
    'button[aria-label*="Generate" i]',
    'button[aria-label*="Buat gambar" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Kirim" i]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
    // Fallback: icon + hidden-label + textContent + proximity
    // discovery handled in content.js findSubmitButton()
  ],

  uploadButton: [
    'button[aria-label="Add image"]',
    'button[aria-label*="Add image" i]',
    'button[aria-label*="Add" i]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Tambahkan" i]',
    'button[aria-label*="Unggah" i]',
    'button[aria-label*="Lampirkan" i]',
    'button .google-symbols:contains("add")', // Note: querySelectorAll doesn't support :contains natively, we will fallback in js
  ],

  dismissOverlays: [
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    'button[aria-label="Tutup"]',
    'button[aria-label*="Got it" i]',
    'button[aria-label*="OK"]',
    '[aria-label*="cookie" i] button',
  ],

  // "What do you want to create?" agent intro panel (appears on page load
  // since the May 2026 Agent update) — auto-dismissed so it never covers
  // the prompt bar.
  agentIntroDismiss: [
    'button[aria-label="Close"]',
    'button[aria-label*="Dismiss" i]',
    'button[aria-label*="Tutup" i]',
  ],
};

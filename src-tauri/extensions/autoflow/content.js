(function () {
  // Singleton guard: static content-script + programmatic re-injection
  // (self-heal) share one isolated world — without this, TWO live copies
  // answer every message and every prompt runs twice (double picker,
  // double submit, "search input not found" from toggle races).
  if (globalThis.__AUTOFLOW_LOADED) {
    console.log("[AUTOFLOW] Already loaded in this page — skipping duplicate.");
    return;
  }
  globalThis.__AUTOFLOW_LOADED = true;

  const AUTOFLOW_VERSION = "1.4.1";
  const LOG_PREFIX = "[AUTOFLOW]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randomIntInclusive(min, max) {
    const a = Math.ceil(min);
    const b = Math.floor(max);
    return a + Math.floor(Math.random() * (b - a + 1));
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  /** Plain text roughly visible in an editor (Slate contenteditable, textarea, or input). */
  function editorPlainText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      return (el.value || "").replace(/\n+/g, " ").trim();
    }
    return (el.innerText || "")
      .replace(/[\u200b\ufeff]/g, "")
      .replace(/\n+/g, " ")
      .trim();
  }

  function editorSeemsToContain(el, text) {
    const t = text.trim();
    if (!t) return false;
    const raw = editorPlainText(el);
    if (raw.includes(t)) return true;
    const head = t.slice(0, Math.min(48, t.length));
    return raw.includes(head);
  }

  /**
   * Deep DOM traversal: query light DOM + all open shadow roots.
   * The 2026 Flow UI (flow.google.com) may encapsulate widgets in shadow DOM.
   */
  function deepQueryAll(selector) {
    const out = [];
    const seen = new Set();
    function scan(root) {
      let els = [];
      try { els = root.querySelectorAll(selector); } catch { return; }
      for (const el of els) {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
      // Recurse into shadow roots AND iframes' documents are handled separately
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    }
    scan(document);
    return out;
  }

  function visibleEls(selector) {
    return deepQueryAll(selector).filter(isVisible);
  }

  function lowestEl(els) {
    if (!els.length) return null;
    return els.sort(
      (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    )[0];
  }

  // Placeholder / label text that identifies the MAIN prompt box
  // (covers EN/ID + 2026 wording like "Ask Flow", "Describe your video").
  const PROMPT_HINT_RE = /what do you want|ask flow|describe|create|generate|prompt|imagine|dream|apa yang ingin|buat|deskripsikan|bayangkan|tulis/i;

  function elHintText(el) {
    try {
      const bits = [
        el.getAttribute?.("placeholder") || "",
        el.getAttribute?.("aria-label") || "",
        el.getAttribute?.("aria-placeholder") || "",
        el.getAttribute?.("data-placeholder") || "",
      ];
      const ph = el.querySelector?.("[data-slate-placeholder], [data-placeholder]");
      if (ph) bits.push(ph.textContent || "");
      return bits.join(" ");
    } catch { return ""; }
  }

  function findFlowPromptEditor() {
    // Family 1: known rich-text editors (Slate classic, Lexical, ProseMirror, Draft, Quill)
    const rich = visibleEls(
      '[data-slate-editor="true"][contenteditable="true"], ' +
      '[data-lexical-editor="true"], div[contenteditable="true"][role="textbox"], ' +
      'div[contenteditable="true"][aria-multiline="true"], ' +
      '.ProseMirror[contenteditable="true"], .DraftEditor-root [contenteditable="true"], ' +
      '.ql-editor[contenteditable="true"]'
    );
    if (rich.length) {
      const withHint = rich.filter((el) => PROMPT_HINT_RE.test(elHintText(el)));
      return lowestEl(withHint.length ? withHint : rich);
    }

    // Family 2: combobox / searchbox roles (possible redesign widget)
    const combo = visibleEls('[role="combobox"], [role="searchbox"]')
      .filter((el) => el.tagName !== "INPUT" || el.type !== "hidden");
    if (combo.length) {
      const withHint = combo.filter((el) => PROMPT_HINT_RE.test(elHintText(el)));
      return lowestEl(withHint.length ? withHint : combo);
    }

    // Family 3: ANY contenteditable with a prompt-like hint anywhere
    const anyEditable = deepQueryAll('[contenteditable="true"]').filter((el) => {
      if (!isVisible(el)) return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return false;
      if (/^(SCRIPT|STYLE|OPTION)$/.test(el.tagName)) return false;
      return true;
    });
    if (anyEditable.length) {
      const withHint = anyEditable.filter((el) => PROMPT_HINT_RE.test(elHintText(el)));
      if (withHint.length) return lowestEl(withHint);
      // Large editables near the bottom (skip tiny inline chips)
      const large = anyEditable.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 24;
      });
      if (large.length) return lowestEl(large);
      return lowestEl(anyEditable);
    }

    // Family 4: textarea / text inputs
    const fields = visibleEls(
      'textarea, input[type="text"], input[type="search"], input:not([type])'
    ).filter((el) => {
      if (el.type === "hidden" || el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      return r.width > 160;
    });
    if (fields.length) {
      const withHint = fields.filter((el) => PROMPT_HINT_RE.test(elHintText(el)));
      return lowestEl(withHint.length ? withHint : fields);
    }

    return null;
  }

  // Auto-diagnostics printed to the page console when the prompt field
  // can't be found — the user pastes these logs back so the selectors
  // can be fixed without guesswork.
  function logPromptDiagnostics() {
    try {
      const ceTotal = document.querySelectorAll('[contenteditable]').length;
      const ceTrue = document.querySelectorAll('[contenteditable="true"]').length;
      const taTotal = document.querySelectorAll("textarea").length;
      const inTotal = document.querySelectorAll("input").length;
      const iframes = Array.from(document.querySelectorAll("iframe"));
      let shadowHosts = 0;
      try {
        if (window.__fqShadowCount !== undefined) shadowHosts = window.__fqShadowCount;
        else {
          const all = document.querySelectorAll("*");
          for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) shadowHosts++;
        }
      } catch { /* ignore */ }
      const labelSamples = [];
      for (const el of document.querySelectorAll("input, textarea, [contenteditable], [role='combobox'], [role='textbox']")) {
        const hint = (elHintText(el) || "").trim().replace(/\s+/g, " ").slice(0, 60);
        if (hint && labelSamples.length < 15 && !labelSamples.includes(hint)) labelSamples.push(`${el.tagName}: "${hint}"`);
      }
      warn("DIAG no-prompt-field | ce total/true:", ceTotal + "/" + ceTrue,
        "| textarea:", taTotal, "| input:", inTotal,
        "| iframes:", iframes.length,
        iframes.slice(0, 5).map((f) => (f.src || f.title || f.id || "?").slice(0, 60)),
        "| shadowHosts:", shadowHosts,
        "| hints:", JSON.stringify(labelSamples));
    } catch (e) {
      warn("DIAG failed:", e?.message || e);
    }
  }

  function firstMatch(selectors) {
    for (const sel of selectors || []) {
      try {
        const els = deepQueryAll(sel);
        if (els.length) return els[0];
      } catch {
        /* invalid selector */
      }
    }
    return null;
  }

  /**
   * Focus like a user: scroll, then click inside the box so React/Slate activates the field.
   */
  async function focusEditorLikeUser(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(40);
    const r = el.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + r.width / 2, r.left + 8), r.right - 8);
    const cy = Math.min(Math.max(r.top + r.height / 2, r.top + 8), r.bottom - 8);
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: 1,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", common));
    el.dispatchEvent(new MouseEvent("click", common));
    el.focus();
    await sleep(50);
  }

  async function selectAllInEditor(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(30);
  }

  async function clearEditorContent(el) {
    await selectAllInEditor(el);
    try {
      document.execCommand("delete", false, null);
    } catch {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        })
      );
    }
    await sleep(40);
  }

  function dispatchSyntheticPaste(el, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(ev, "clipboardData", {
        value: dt,
        enumerable: true,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
    return el.dispatchEvent(ev);
  }

  async function typeInsertTextEvents(el, text, charDelayMs) {
    // The editor node may have been detached by a UI re-render
    // (e.g. asset picker open/close) — fail gracefully instead of throwing.
    if (!el || !el.isConnected) {
      warn("typeInsertTextEvents: editor detached, skipping.");
      return false;
    }
    el.focus();
    const endSel = window.getSelection();
    try {
      const endRange = document.createRange();
      endRange.selectNodeContents(el);
      endRange.collapse(false);
      endSel.removeAllRanges();
      endSel.addRange(endRange);
    } catch (e) {
      warn("typeInsertTextEvents: cannot set caret:", e?.message || e);
      return false;
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: "insertText",
          data: char,
        })
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: char,
        })
      );
      if (charDelayMs > 0) await sleep(charDelayMs);
    }
  }

  /**
   * Slate/React ignores raw DOM writes — drive the same path as typing/pasting.
   */
  async function clickPlusButton() {
    // Google Flow has multiple '+' buttons:
    //   - Top toolbar / header: opens Upload/Create menu (WRONG)
    //   - Near prompt bar: opens asset picker (CORRECT)
    // The correct one lives INSIDE the prompt-bar container, so search
    // there first and only fall back to page-wide proximity below the header.

    const promptEditor = findFlowPromptEditor();
    const promptRect = promptEditor ? promptEditor.getBoundingClientRect() : null;
    const promptBottom = promptRect ? promptRect.bottom : window.innerHeight;
    const promptMidY = promptRect ? promptRect.top + promptRect.height / 2 : window.innerHeight - 120;

    const isPlusBtn = (b, submitBtn, strict) => {
      if (b === submitBtn) return false;
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      if (/add image|upload|attach|tambah|unggah|lampirkan|asset|ingredient|reference|referensi|media|insert|sisipkan/i.test(aria)) return true;
      // Header/menu buttons (new project, create menu) are never the picker.
      if (/new project|buat project|create new|menu/i.test(aria)) return false;
      const text = (b.textContent || "").trim();
      if (text.includes("add_2") || text === "add" ||
        text === "add_circle" || text === "add_photo_alternate") return true;
      return false;
    };

    // The submit button is never the picker — resolve once to exclude it.
    let submitBtn = null;
    try {
      submitBtn = findSubmitButton(globalThis.FLOW_BATCH_DEFAULT_SELECTORS);
    } catch { /* ignore */ }

    // 1. Scoped: buttons inside the prompt-bar container (wide, short box
    //    around the editor), with STRICT matching (v1.3.1 rules + picker
    //    keywords). Loose guesses are not allowed here.
    if (promptEditor) {
      let container = promptEditor.parentElement;
      for (let up = 0; up < 8 && container && container !== document.body; up++) {
        const r = container.getBoundingClientRect();
        if (r.width > 400 && r.height < 320) break;
        container = container.parentElement;
      }
      if (container && container !== document.body) {
        const scoped = Array.from(container.querySelectorAll("button"))
          .filter((b) => isVisible(b) && isPlusBtn(b, submitBtn, true));
        if (scoped.length) {
          scoped.sort((a, b) =>
            Math.abs(a.getBoundingClientRect().left - (promptRect.left || 0)) -
            Math.abs(b.getBoundingClientRect().left - (promptRect.left || 0)));
          log("Found '+' button inside prompt bar, clicking it.");
          try {
            scoped[0].click();
            return true;
          } catch (e) {
            warn("Prompt-bar '+' click failed (stale node):", e?.message || e);
          }
        }
      }
    }

    // 2. Global v1.3.1 rule (proven on this UI): every visible "+"-like
    //    button, nearest to the prompt editor's bottom wins. No vertical-band
    //    or header filters — those wrongly discarded the real button.
    //    Only the submit button itself is excluded (plus try/catch safety).
    const candidates = [];
    const selectors = globalThis.FLOW_BATCH_DEFAULT_SELECTORS.uploadButton || [];
    for (const sel of selectors.filter(s => !s.includes(':contains'))) {
      try {
        document.querySelectorAll(sel).forEach(b => {
          if (b !== submitBtn && isVisible(b)) candidates.push(b);
        });
      } catch { /* invalid selector */ }
    }
    for (const b of document.querySelectorAll("button")) {
      if (b !== submitBtn && !candidates.includes(b) && isPlusBtn(b, submitBtn, true)) {
        if (isVisible(b)) candidates.push(b);
      }
    }

    if (!candidates.length) return false;

    // Pick the candidate closest to the prompt editor
    candidates.sort((a, b) => {
      const distA = Math.abs(a.getBoundingClientRect().bottom - promptBottom);
      const distB = Math.abs(b.getBoundingClientRect().bottom - promptBottom);
      return distA - distB;
    });

    const btn = candidates[0];
    log("Found '+' button (nearest to prompt), clicking it.");
    try {
      btn.click();
    } catch (e) {
      warn("Fallback '+' click failed (stale node):", e?.message || e);
      return false;
    }
    return true;
  }

  // Picker search field. CRITICAL: the page-level PROJECT search bar also
  // matches "search/asset" wording, so it must NEVER be treated as the
  // picker. Only inputs inside a dialog/listbox/menu (the picker popup)
  // qualify — for reuse AND for post-click discovery (with a
  // newly-appeared-input preference so a lingering project search is ignored).
  const ASSET_SEARCH_RE = /telusuri|search|cari|asset|character|karakter/i;

  function allSearchInputs() {
    const out = [];
    for (const el of document.querySelectorAll("input")) {
      if (!isVisible(el) || el.type === "hidden" || el.disabled) continue;
      const hay = `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
      if (!ASSET_SEARCH_RE.test(hay)) continue;
      out.push(el);
    }
    return out;
  }

  function inPickerPopup(el) {
    return !!el.closest('[role="dialog"], [role="listbox"], [role="menu"], [data-popper-placement], [data-radix-popper-content-wrapper]');
  }

  function openPopups() {
    return deepQueryAll('[role="dialog"], [role="listbox"], [role="menu"]')
      .filter(isVisible);
  }

  // The popup that appeared after clicking "+" — this IS the asset picker,
  // not some older dialog that happens to contain a search field.
  async function waitNewPopup(before, rounds) {
    for (let i = 0; i < (rounds ?? 20); i++) {
      const cur = openPopups().find((p) => !before.has(p));
      if (cur) return cur;
      await sleep(300);
    }
    return openPopups().find((p) => !before.has(p)) || null;
  }

  // Search field inside a specific popup: keyword match first, else the
  // first visible text/search input (some pickers have no placeholder).
  function findSearchInPopup(popup) {
    if (!popup) return null;
    const inputs = Array.from(popup.querySelectorAll("input"))
      .filter((el) => isVisible(el) && el.type !== "hidden" && !el.disabled);
    if (!inputs.length) return null;
    const kw = inputs.find((el) =>
      ASSET_SEARCH_RE.test(`${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`));
    if (kw) return kw;
    return inputs.find((el) => !el.type || el.type === "text" || el.type === "search") || inputs[0];
  }

  function queryDialogSearchInput(exclude) {
    for (const el of allSearchInputs()) {
      if (exclude && exclude.has(el)) continue;
      if (inPickerPopup(el)) return el;
    }
    return null;
  }

  async function waitDialogSearchInput(exclude, rounds) {
    for (let i = 0; i < (rounds ?? 20); i++) {
      const el = queryDialogSearchInput(exclude);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  // Add a project asset (already in Flow) to the prompt by searching in the picker
  async function addAssetToPromptByName(assetName) {
    log(`addAsset: opening picker for "${assetName}"…`);

    // Snapshot first: inputs/popups that already exist (e.g. the page-level
    // PROJECT search bar) must never be mistaken for the picker.
    const preExisting = new Set(allSearchInputs());
    const popupsBefore = new Set(openPopups());
    let activePopup = null;

    // Picker may already be open from a previous prompt — reuse it instead
    // of clicking "+" (which would toggle it closed). Dialog-only: the
    // project search bar is never a valid reuse target.
    let searchInput = queryDialogSearchInput(null);
    if (searchInput) {
      activePopup = searchInput.closest('[role="dialog"], [role="listbox"], [role="menu"]');
      log(`addAsset: picker already open, reusing search for "${assetName}"…`);
    } else {
      const opened = await clickPlusButton();
      if (!opened) { warn(`addAsset: could not open picker for "${assetName}"`); return false; }
      await sleep(1200);
      activePopup = await waitNewPopup(popupsBefore, 20);
      searchInput = findSearchInPopup(activePopup) || await waitDialogSearchInput(preExisting, 8);

      if (!searchInput) {
        // Inline picker without dialog role (v1.3.1 found these document-wide):
        // accept any search input that appeared AFTER the "+" click.
        // Pre-existing ones (project search bar) stay excluded.
        for (let i = 0; i < 10; i++) {
          const fresh = allSearchInputs().find((el) => !preExisting.has(el));
          if (fresh) {
            searchInput = fresh;
            activePopup = null;
            log("addAsset: using newly appeared search input (inline picker)…");
            break;
          }
          await sleep(300);
        }
      }

      if (!searchInput) {
        // The click may have toggled an open-but-unnoticed picker closed —
        // click once more to reopen, then look again.
        log(`addAsset: search not found, toggling picker once more…`);
        await clickPlusButton();
        await sleep(1200);
        activePopup = await waitNewPopup(popupsBefore, 20);
        searchInput = findSearchInPopup(activePopup) || await waitDialogSearchInput(preExisting, 8);
      }
      // Last resort: any dialog search input, even a lingering one.
      if (!searchInput) {
        searchInput = queryDialogSearchInput(null);
        if (searchInput) activePopup = searchInput.closest('[role="dialog"], [role="listbox"], [role="menu"]');
      }
    }

    if (!searchInput) {
      warn(`addAsset: search input not found for "${assetName}"`);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    }

    // The picker panel is the popup that just opened (it holds the asset
    // grid). Fall back to climbing from the search input if needed.
    let pickerPanel = (activePopup && activePopup.isConnected) ? activePopup : null;
    if (!pickerPanel ||
      !(pickerPanel.querySelectorAll("img").length > 1 && pickerPanel.getBoundingClientRect().width > 300)) {
      pickerPanel =
        searchInput.closest('[role="dialog"], [role="listbox"], [role="menu"]') ||
        searchInput.parentElement;
    }
    if (!pickerPanel || pickerPanel === document.body) pickerPanel = searchInput.parentElement;
    for (let up = 0; up < 12; up++) {
      if (!pickerPanel.parentElement || pickerPanel === document.body) break;
      const pr = pickerPanel.getBoundingClientRect();
      if (pr.width > 300 && pr.height > 300 && pickerPanel.querySelectorAll("img").length > 1) break;
      pickerPanel = pickerPanel.parentElement;
    }

    // Wait for the panel's images to load before typing (else the first
    // search runs against an empty grid and never matches).
    for (let w = 0; w < 10; w++) {
      if (pickerPanel.querySelectorAll("img").length > 1) break;
      await sleep(300);
    }

    // Clear previous search reliably: focus, select-all, delete, then
    // React-compatible native setter + per-character typing.
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    searchInput.focus();
    await sleep(80);
    try {
      searchInput.select();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch { /* ignore */ }
    nativeSetter.call(searchInput, "");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);

    for (const ch of assetName) {
      nativeSetter.call(searchInput, searchInput.value + ch);
      searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      await sleep(40);
    }
    await sleep(1200);
    log(`addAsset: typed "${assetName}" in search`);

    // Find matching item WITHIN the picker panel only.
    // Normalized comparison ignores separators, so "wafiq_stikmen"
    // also matches a card rendered as "wafiq stikmen" or "Wafiq-Stikmen".
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const want = norm(assetName);
    const textHit = (s) => {
      const t = (s || "").trim().toLowerCase();
      return t.includes(assetName.toLowerCase()) || (want && norm(t).includes(want));
    };
    let matchedItem = null;
    for (let i = 0; i < 20; i++) {
      const panelImgs = Array.from(pickerPanel.querySelectorAll("img")).filter(isVisible);

      for (const img of panelImgs) {
        let itemEl = img.parentElement;
        for (let u = 0; u < 6; u++) {
          if (!itemEl || itemEl === pickerPanel) break;
          const itemText = itemEl.textContent.trim();
          if (textHit(itemText)) {
            const itemRect = itemEl.getBoundingClientRect();
            if (itemRect.height < 200 && itemRect.width < 400) {
              matchedItem = itemEl;
              break;
            }
          }
          itemEl = itemEl.parentElement;
        }
        if (matchedItem) break;
      }

      // Fallback: check img alt / aria-label attributes
      if (!matchedItem) {
        const altMatch = panelImgs.find(img =>
          textHit(img.alt) || textHit(img.getAttribute("aria-label")));
        if (altMatch) matchedItem = altMatch.parentElement;
      }

      if (matchedItem) break;
      await sleep(300);
    }

    if (!matchedItem) {
      warn(`addAsset: no match found for "${assetName}" in picker panel`);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(400);
      return false;
    }

    log(`addAsset: found item for "${assetName}", double-clicking…`);

    // Select with single click first
    matchedItem.click();
    await sleep(500);

    // Double-click to add to prompt (proven to work)
    const r = matchedItem.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };

    matchedItem.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    matchedItem.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1, detail: 1 }));
    matchedItem.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse", buttons: 0 }));
    matchedItem.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0, detail: 1 }));
    matchedItem.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0, detail: 1 }));

    matchedItem.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    matchedItem.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1, detail: 2 }));
    matchedItem.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse", buttons: 0 }));
    matchedItem.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0, detail: 2 }));
    matchedItem.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0, detail: 2 }));
    matchedItem.dispatchEvent(new MouseEvent("dblclick", { ...opts, buttons: 0, detail: 2 }));

    await sleep(800);

    // If picker still open, also try double-clicking the <img> inside
    if (isVisible(searchInput)) {
      const innerImg = matchedItem.querySelector("img");
      if (innerImg) {
        const ir = innerImg.getBoundingClientRect();
        const icx = ir.left + ir.width / 2;
        const icy = ir.top + ir.height / 2;
        const io = { bubbles: true, cancelable: true, view: window, clientX: icx, clientY: icy, button: 0 };
        innerImg.dispatchEvent(new MouseEvent("click", { ...io, detail: 1 }));
        innerImg.dispatchEvent(new MouseEvent("click", { ...io, detail: 2 }));
        innerImg.dispatchEvent(new MouseEvent("dblclick", { ...io, detail: 2 }));
        await sleep(800);
      }
    }

    // Fallback: try clicking "Tambahkan ke Perintah" button if picker still open
    if (isVisible(searchInput)) {
      const addBtn = Array.from(document.querySelectorAll("button"))
        .find(btn => isVisible(btn) && /add to prompt|tambahkan ke perintah|tambahkan/i.test(btn.textContent));
      if (addBtn) {
        addBtn.click();
        log(`addAsset: fallback — "Tambahkan ke Perintah" clicked for "${assetName}"`);
        await sleep(700);
      }
    }

    log(`addAsset: completed for "${assetName}"`);

    // Close the picker if still open so the prompt bar is free for typing.
    for (let c = 0; c < 3; c++) {
      if (!isVisible(searchInput)) break;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      await sleep(400);
    }
    await sleep(600);
    return true;
  }

  async function injectTextIntoFlowPrompt(el, text, charDelayMs) {
    if (!text) return false;
    if (!el || !el.isConnected) {
      warn("injectText: editor node is detached (UI re-rendered?) — caller should re-find it.");
      return false;
    }

    // Native textarea / input path (2026 redesign fallback)
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      try {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value"
        )?.set;
        const protoSetter = setter || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (protoSetter) protoSetter.call(el, "");
        else el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(60);
        // Type in chunks (fast) so React picks it up, then verify
        const CHUNK = 64;
        for (let i = 0; i < text.length; i += CHUNK) {
          const part = text.slice(i, i + CHUNK);
          const cur = el.value || "";
          if (protoSetter) protoSetter.call(el, cur + part);
          else el.value = cur + part;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: part }));
          if (charDelayMs > 0) await sleep(Math.min(charDelayMs, 10));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(200);
        if (editorSeemsToContain(el, text)) {
          log("Filled prompt via native value setter (textarea/input).");
          return true;
        }
      } catch (e) {
        warn("Textarea fill failed:", e?.message || e);
      }
      // Fall through to generic attempts below
    }

    // 1. Try synthetic paste
    dispatchSyntheticPaste(el, text);
    await sleep(200);
    if (editorSeemsToContain(el, text)) {
      log("Filled prompt via synthetic paste.");
      return true;
    }

    // 2. Try beforeinput
    log("Text not found, trying beforeinput...");
    const before = new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, composed: true,
      inputType: "insertText", data: text,
    });
    el.dispatchEvent(before);
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true, composed: true,
      inputType: "insertText", data: text,
    }));
    await sleep(200);
    if (editorSeemsToContain(el, text)) {
      log("Filled prompt via insertText beforeinput.");
      return true;
    }

    // 3. Try execCommand insertText — full text at once (instant)
    log("Trying execCommand insertText (full text)...");
    try { document.execCommand("insertText", false, text); } catch {}
    await sleep(200);
    if (editorSeemsToContain(el, text)) {
      log("Filled prompt via execCommand insertText.");
      return true;
    }

    // 4. Try InputEvents per character (last resort — slow but works)
    log("Trying per-character InputEvent insertText...");
    await typeInsertTextEvents(el, text, 0);
    await sleep(200);
    if (editorSeemsToContain(el, text)) {
      log("Filled prompt via synthetic InputEvents.");
      return true;
    }

    log("Prompt verification failed; editor text:", editorPlainText(el).slice(0, 120));
    return false;
  }

  function findCreateButtonByArrowIcon() {
    const SUBMIT_ICONS = new Set([
      "arrow_forward", "arrow_upward", "send", "north", "east",
      "generating_tokens", "auto_awesome",
    ]);
    const candidates = [];
    for (const btn of document.querySelectorAll("button")) {
      if (!isVisible(btn)) continue;
      // Skip asset-picker "+" buttons
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (/add image|upload|attach|tambah|unggah|lampirkan/.test(aria)) continue;
      const icon = btn.querySelector("i.google-symbols, i.material-symbols, i[class*='symbol'], span.google-symbols, span.material-symbols-outlined, svg");
      const iconText = (icon?.textContent || "").trim();
      if (icon && (SUBMIT_ICONS.has(iconText) || icon.tagName?.toLowerCase() === "svg")) {
        // SVG-only round button near the prompt bar is very likely the submit button
        candidates.push(btn);
      } else if (icon && SUBMIT_ICONS.has(iconText)) {
        candidates.push(btn);
      }
    }
    if (!candidates.length) return null;
    // Prefer enabled buttons closest to (at/below) the prompt editor
    const editor = findFlowPromptEditor();
    const editorBottom = editor ? editor.getBoundingClientRect().bottom : window.innerHeight;
    return candidates.sort((a, b) => {
      const aDis = a.disabled ? 1e9 : 0;
      const bDis = b.disabled ? 1e9 : 0;
      if (aDis !== bDis) return aDis - bDis;
      const da = Math.abs(a.getBoundingClientRect().top - editorBottom);
      const db = Math.abs(b.getBoundingClientRect().top - editorBottom);
      return da - db;
    })[0];
  }

  /**
   * Find the Create/Generate button by its accessible label.
   * Google Flow wraps the label in a visually-hidden <span> inside the button.
   * 2026 redesign may say "Create", "Generate", "Send", or localized text.
   */
  function findCreateButtonByHiddenLabel() {
    const LABELS = ["create", "generate", "send", "buat", "kirim", "hasilkan"];
    for (const btn of document.querySelectorAll("button")) {
      if (!isVisible(btn)) continue;
      const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
      if (aria && LABELS.some((l) => aria.includes(l))) return btn;
      const spans = btn.querySelectorAll("span");
      for (const span of spans) {
        const t = span.textContent?.trim().toLowerCase();
        if (t && LABELS.includes(t)) {
          return btn;
        }
      }
    }
    return null;
  }

  /**
   * Consolidated submit button discovery with diagnostic logging.
   * Includes a proximity fallback: enabled button nearest to the prompt bar.
   */
  function findSubmitButton(selectors) {
    let btn = firstMatch(selectors.submitButton || []);
    if (btn && isVisible(btn)) {
      log("Submit button found via CSS selector.");
      return btn;
    }

    btn = findCreateButtonByArrowIcon();
    if (btn) {
      log("Submit button found via icon.");
      return btn;
    }

    btn = findCreateButtonByHiddenLabel();
    if (btn) {
      log("Submit button found via label.");
      return btn;
    }

    for (const b of document.querySelectorAll("button")) {
      if (!isVisible(b)) continue;
      const t = (b.textContent || "").toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      if (/create|generate|send|buat|kirim/.test(t) || /create|generate|send|buat|kirim/.test(aria)) {
        log("Submit button found via textContent scan.");
        return b;
      }
    }

    // Proximity fallback: nearest enabled icon-button at/below the prompt bar
    try {
      const editor = findFlowPromptEditor();
      const ref = editor ? editor.getBoundingClientRect().bottom : window.innerHeight - 200;
      let best = null;
      let bestDist = Infinity;
      for (const b of document.querySelectorAll("button")) {
        if (!isVisible(b) || b.disabled) continue;
        const r = b.getBoundingClientRect();
        // Round-ish small buttons near the prompt bar (send buttons are circular)
        const roundish = Math.abs(r.width - r.height) < 16 && r.width >= 28 && r.width <= 72;
        if (!roundish) continue;
        const dist = Math.abs(r.top - ref);
        if (dist < 400 && dist < bestDist) {
          bestDist = dist;
          best = b;
        }
      }
      if (best) {
        log("Submit button found via proximity fallback.");
        return best;
      }
    } catch { /* ignore */ }

    warn("Submit button NOT found by any strategy.");
    return null;
  }

  /* ── MAIN world React fiber click ──────────────────────────────────
   * Marks the target element, then asks the background service worker
   * to inject a function via chrome.scripting.executeScript in the
   * MAIN world. This bypasses both CSP and isTrusted checks — the
   * injected code calls React's onClick handler directly.
   * ---------------------------------------------------------------- */

  const FQ_MARKER_ATTR = "data-fq-click-target";
  let fqClickCounter = 0;

  async function clickViaReactFiber(el) {
    const token = String(++fqClickCounter);
    el.setAttribute(FQ_MARKER_ATTR, token);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "REACT_FIBER_CLICK",
        token,
        markerAttr: FQ_MARKER_ATTR,
      });
      return result || { ok: false, reason: "no response from background" };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    } finally {
      el.removeAttribute(FQ_MARKER_ATTR);
    }
  }

  /**
   * Click a button with ONE activation only.
   * Previously this dispatched a synthetic click AND called btn.click(),
   * which fired TWO click events → Flow generated TWICE per prompt
   * (one card failed with "maaf gambar gagal dibuat"). Never do both.
   */
  function clickButtonSynthetic(btn) {
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: 1,
    };
    btn.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse" }));
    btn.dispatchEvent(new MouseEvent("mousedown", common));
    btn.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    btn.dispatchEvent(new MouseEvent("mouseup", common));
    btn.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    // NOTE: no btn.click() here — the synthetic click above IS the activation.
  }

  // Single native .click() executed in the page's MAIN world via background.
  // Used when the button has no React fiber (2026 non-React UI).
  async function clickViaMainWorld(el) {
    const token = String(++fqClickCounter);
    el.setAttribute(FQ_MARKER_ATTR, token);
    try {
      return await chrome.runtime.sendMessage({
        type: "MAIN_WORLD_DIRECT_CLICK",
        token,
        markerAttr: FQ_MARKER_ATTR,
      });
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    } finally {
      el.removeAttribute(FQ_MARKER_ATTR);
    }
  }

  /**
   * Try all click strategies, each firing EXACTLY ONE activation:
   * React fiber handler → MAIN-world .click() → single synthetic sequence
   */
  async function clickSubmitButton(btn) {
    // Attempt 1: React fiber direct call (bypasses isTrusted entirely).
    // Miss is NORMAL on the 2026 non-React UI — not an error, so log only.
    const fiberResult = await clickViaReactFiber(btn);
    if (fiberResult.ok) {
      log(`Submit via React fiber: ${fiberResult.method} at depth ${fiberResult.depth}`);
      return true;
    }
    log("React fiber not present, using MAIN-world click...");

    // Attempt 2: single native click in MAIN world (works without React fiber)
    try {
      const direct = await clickViaMainWorld(btn);
      if (direct?.ok) {
        log("Submit via MAIN-world click.");
        return true;
      }
      log("MAIN-world click missed, using synthetic click...");
    } catch (e) {
      log("MAIN-world click error:", e?.message || e);
    }

    // Attempt 3: single synthetic pointer/mouse sequence (last resort)
    log("Submitting via synthetic click events...");
    clickButtonSynthetic(btn);
    return true;
  }

  function submitViaEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  async function dismissOptionalOverlays(selectorsConfig) {
    const list = selectorsConfig.dismissOverlays || [];
    for (let i = 0; i < 3; i++) {
      const btn = firstMatch(list);
      if (btn && isVisible(btn)) {
        btn.click();
        await sleep(400);
      } else break;
    }
    // Agent intro panel ("What do you want to create?") — close without
    // touching the main prompt bar. Only dismiss dialogs in the top half
    // of the viewport so we never close the asset picker by accident.
    try {
      for (const btn of document.querySelectorAll('button[aria-label="Close"], button[aria-label*="Dismiss" i]')) {
        if (!isVisible(btn)) continue;
        const r = btn.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.5) {
          const dlg = btn.closest('[role="dialog"]');
          const label = ((dlg?.textContent || "") + "").toLowerCase();
          if (dlg && /what do you want to create|agent|welcome/i.test(label)) {
            btn.click();
            await sleep(300);
            break;
          }
        }
      }
    } catch { /* ignore */ }
  }

  let runToken = 0;

  async function runQueue(payload) {
    const token = ++runToken;
    let prompts = (payload.prompts || []).map((p) => String(p).trim()).filter(Boolean);
    const waitMinMs = Math.max(0, payload.waitMinMs ?? 10_000);
    const waitMaxMs = Math.max(waitMinMs, payload.waitMaxMs ?? 30_000);
    const preferEnter = payload.preferEnter === true;
    const charDelayMs   = Math.max(0, payload.charDelayMs ?? 50);
    const refAssetNames = payload.refAssetNames || [];

    /** Only bundled defaults — never merge message-supplied selectors (reduces attack surface). */
    const selectors = globalThis.FLOW_BATCH_DEFAULT_SELECTORS;

    for (let i = 0; i < prompts.length; i++) {
      if (token !== runToken) {
        log("Stopped by user.");
        return { stopped: true, completed: i };
      }

      const text = prompts[i];

      await dismissOptionalOverlays(selectors);

      let input = findFlowPromptEditor();
      if (!input) {
        input = firstMatch(selectors.promptInput || []);
      }
      if (!input || !isVisible(input)) {
        const msg =
          "Could not find prompt field. Open a Flow project tab (flow.google or labs.google/fx/tools/flow/project/…) and try again.";
        log(msg);
        logPromptDiagnostics();
        return { error: msg, completed: i, failedPromptIndex: i };
      }

      // Add matching project assets to the prompt before typing
      for (const assetName of refAssetNames) {
        if (token !== runToken) break;
        await addAssetToPromptByName(assetName);
      }

      // The picker open/close re-renders the prompt bar, detaching the old
      // node (paste/caret then silently fail on the dead node). Always
      // re-find a LIVE editor after attaching assets.
      if (refAssetNames.length) {
        await sleep(400);
        const live = findFlowPromptEditor() || firstMatch(selectors.promptInput || []);
        if (live && isVisible(live)) {
          if (live !== input) log("Prompt editor re-rendered — using fresh node.");
          input = live;
        } else {
          warn("Prompt editor lost after attaching assets; retrying lookup once…");
          await sleep(800);
          const retry = findFlowPromptEditor() || firstMatch(selectors.promptInput || []);
          if (retry && isVisible(retry)) input = retry;
        }
        await focusEditorLikeUser(input);
      }

      const ok = await injectTextIntoFlowPrompt(input, text, charDelayMs);
      if (!ok) {
        return {
          error:
            "Could not set prompt text in a way Flow accepts. Try entering one prompt manually once, then retry the queue.",
          completed: i,
          failedPromptIndex: i,
        };
      }

      await sleep(200);

      let submitted = false;
      if (!preferEnter) {
        const submit = findSubmitButton(selectors);
        if (submit) {
          try {
            await clickSubmitButton(submit);
            submitted = true;
            log(`Submitted prompt ${i + 1}/${prompts.length}.`);
          } catch (e) {
            warn(`Click failed for prompt ${i + 1}:`, e?.message || e);
          }
        } else {
          warn(`No submit button found for prompt ${i + 1}, will try Enter.`);
        }
      }
      if (!submitted) {
        submitViaEnter(input);
        log(`Sent Enter to submit (prompt ${i + 1}/${prompts.length})`);
      }

      if (i < prompts.length - 1) {
        const pause = randomIntInclusive(waitMinMs, waitMaxMs);
        log(`Waiting ${Math.round(pause / 1000)}s before next prompt…`);
        await sleep(pause);
      }
    }

    return { done: true, completed: prompts.length };
  }

  // Count failure cards by the "Retry" span inside a button.
  // Covers EN + ID + common redesign labels.
  function countFailCards() {
    var n = 0;
    document.querySelectorAll("button span").forEach(function(span) {
      if (span.children.length !== 0) return;
      var t = span.textContent.trim().toLowerCase();
      if (t === "retry" || t === "coba lagi" || t === "try again" || t === "regenerate") n++;
    });
    // Redesign fallback: role=alert with failure wording near media grid
    if (n === 0) {
      document.querySelectorAll('[role="alert"]').forEach(function(el) {
        if (/fail|error|gagal|went wrong/i.test(el.textContent || "")) n++;
      });
    }
    return n;
  }

  // Collect ALL plausible generated-media <img> srcs.
  // Classic UI tags alt="Generated image …"; the 2026 asset grid may use
  // different alt text or none — so accept any sufficiently large http(s)
  // image and filter out UI chrome (icons, avatars, logos).
  function collectAllImageSrcs() {
    const out = [];
    for (const img of document.querySelectorAll("img[src]")) {
      const src = img.currentSrc || img.src || "";
      if (!src || (!src.startsWith("http") && !src.startsWith("blob:"))) continue;
      if (src.startsWith("blob:")) continue; // in-progress render, not a result
      if (/google.*logo|avatar|profile|icon|sprite|emoji/i.test(src)) continue;
      if (/gstatic\.com\/(images|icons)|ssl\.gstatic|fonts\.gstatic/i.test(src)) continue;
      const r = img.getBoundingClientRect();
      // Accept images even when scrolled off-screen (rect 0) as long as
      // they carry content-ish dimensions once laid out.
      const w = img.naturalWidth || r.width;
      const h = img.naturalHeight || r.height;
      if (w > 0 && w < 48 && h > 0 && h < 48) continue; // tiny UI icons
      if (img.alt && /logo|icon|avatar|profile|button/i.test(img.alt)) continue;
      out.push(src);
    }
    return [...new Set(out)];
  }

  function collectAllVideoSrcs() {
    const out = [];
    for (const v of document.querySelectorAll("video, video source")) {
      const src = v.currentSrc || v.src || "";
      if (!src || (!src.startsWith("http") && !src.startsWith("blob:"))) continue;
      if (src.startsWith("blob:")) continue;
      out.push(src);
    }
    // Posters of completed video cards
    for (const img of document.querySelectorAll('img[poster], video[poster]')) {
      const p = img.getAttribute("poster") || "";
      if (p.startsWith("http")) out.push(p);
    }
    return [...new Set(out)];
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      return;
    }
    if (message?.type === "FLOW_BATCH_PING") {
      sendResponse({ ok: true, href: location.href });
      return;
    }
    if (message?.type === "FLOW_BATCH_RUN") {
      runQueue(message)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    }
    if (message?.type === "FLOW_BATCH_STOP") {
      runToken++;
      sendResponse({ ok: true });
    }

    if (message?.type === "FLOW_GET_AGENT_MODE") {
      const agentBtn = Array.from(document.querySelectorAll("button[aria-pressed]"))
        .find(b => /agent/i.test(b.textContent));
      const isOn = agentBtn?.getAttribute("aria-pressed") === "true";
      const found = !!agentBtn;
      sendResponse({ found, isOn });
      return;
    }

    if (message?.type === "FLOW_DISABLE_AGENT_MODE") {
      (async function () {
        const getAgentBtn = () =>
          Array.from(document.querySelectorAll("button[aria-pressed]"))
            .find(b => /agent/i.test(b.textContent));

        const btn = getAgentBtn();

        // Already off or not found
        if (!btn || btn.getAttribute("aria-pressed") !== "true") {
          sendResponse({ ok: true, skipped: true });
          return;
        }

        // Click in main world via background scripting (bypasses isolated world)
        const clickRes = await chrome.runtime.sendMessage({ type: "MAIN_WORLD_AGENT_CLICK" });
        log("Agent click result:", JSON.stringify(clickRes));

        // Wait up to 3s for aria-pressed to flip to false
        for (let i = 0; i < 15; i++) {
          await sleep(200);
          const b = getAgentBtn();
          if (!b || b.getAttribute("aria-pressed") === "false") {
            sendResponse({ ok: true });
            return;
          }
        }

        sendResponse({ ok: false, error: "Agent mode still on after click" });
      })();
      return true;
    }

    if (message?.type === "FLOW_GET_TILE_COUNT") {
      // Scroll ALL existing images into view to force lazy loading before snapshot
      // This prevents off-screen images from being mistaken as "new" during generation
      (async function() {
        const imgs = Array.from(document.querySelectorAll("img[src]")).filter(isVisible);

        // Scroll each image into view to trigger lazy src loading
        for (const img of imgs) {
          try { img.scrollIntoView({ behavior: "instant", block: "nearest" }); } catch { img.scrollIntoView(); }
        }

        // Wait for lazy images to load their src
        if (imgs.length > 0) await sleep(800);

        // Now capture the complete snapshot — all srcs should be loaded
        const realSrcs = collectAllImageSrcs();

        // Also snapshot existing video srcs
        const videoSrcs = collectAllVideoSrcs();

        sendResponse({
          count: realSrcs.length,
          srcs: realSrcs,
          videoSrcs,
          failCount: countFailCards(),
        });
      })();
      return true; // async sendResponse
    }

    if (message?.type === "FLOW_WAIT_GENERATION") {
      const beforeSrcs      = new Set(message.beforeSrcs   || []);
      const beforeVideoSrcs = new Set(message.beforeVideoSrcs || []);
      const beforeFailCount = message.beforeFailCount ?? 0;
      const timeout         = message.timeoutMs    ?? 300000; // 5 min for videos

      // Detect new images (classic alt-based + generic asset-grid fallback)
      function getRealImageUrls() {
        return collectAllImageSrcs()
          .filter(src => src.startsWith("http") && !beforeSrcs.has(src));
      }

      // Detect new videos — Flow renders completed videos as <video> elements with a src
      function getRealVideoUrls() {
        return collectAllVideoSrcs()
          .filter(src => src.startsWith("http") && !beforeVideoSrcs.has(src));
      }

      function hasNewMedia() {
        return getRealImageUrls().length > 0 || getRealVideoUrls().length > 0;
      }

      function getNewUrls() {
        return [...getRealImageUrls(), ...getRealVideoUrls()];
      }

      function hasNewFailure() {
        return countFailCards() > beforeFailCount;
      }

      if (hasNewMedia()) { sendResponse({ done: true, newUrls: getNewUrls() }); return; }
      if (hasNewFailure())   { sendResponse({ failed: true }); return; }

      let resolved = false;

      function finish(result) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(pollInterval);
        observer.disconnect();
        sendResponse(result);
      }

      const timer = setTimeout(() => finish({ timeout: true }), timeout);

      // Poll every 3s (videos take longer)
      const pollInterval = setInterval(function() {
        if (hasNewMedia()) finish({ done: true, newUrls: getNewUrls() });
        else if (hasNewFailure()) finish({ failed: true });
      }, 3000);

      // MutationObserver for fast detection
      const observer = new MutationObserver(function() {
        if (hasNewMedia()) finish({ done: true, newUrls: getNewUrls() });
        else if (hasNewFailure()) finish({ failed: true });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["alt", "src"],
      });

      return true;
    }

    if (message?.type === "FLOW_DIAGNOSE") {
      try {
        const slateCount = deepQueryAll('[data-slate-editor="true"]').length;
        const editableCount = deepQueryAll('[contenteditable="true"]').length;
        const textareaCount = deepQueryAll("textarea").length;
        const comboCount = deepQueryAll('[role="combobox"], [role="searchbox"]').length;
        const iframeSrcs = Array.from(document.querySelectorAll("iframe"))
          .slice(0, 8).map((f) => (f.src || f.title || f.id || "?").slice(0, 80));
        const hints = [];
        for (const el of document.querySelectorAll("input, textarea, [contenteditable], [role='combobox'], [role='textbox']")) {
          const h = (elHintText(el) || "").trim().replace(/\s+/g, " ").slice(0, 60);
          if (h && hints.length < 15 && !hints.includes(h)) hints.push(`${el.tagName}: "${h}"`);
        }
        const editor = findFlowPromptEditor();
        const er = editor ? editor.getBoundingClientRect() : null;
        const submit = findSubmitButton(globalThis.FLOW_BATCH_DEFAULT_SELECTORS);
        const sr = submit ? submit.getBoundingClientRect() : null;
        sendResponse({
          ok: true,
          href: location.href,
          slateCount,
          editableCount,
          textareaCount,
          comboCount,
          iframeSrcs,
          hints,
          editor: editor ? {
            tag: editor.tagName,
            role: editor.getAttribute("role"),
            placeholder: (editor.querySelector?.("[data-slate-placeholder]")?.textContent || editor.getAttribute?.("placeholder") || "").slice(0, 80),
            rect: er ? { x: Math.round(er.x), y: Math.round(er.y), w: Math.round(er.width), h: Math.round(er.height) } : null,
          } : null,
          submit: submit ? {
            tag: submit.tagName,
            aria: (submit.getAttribute("aria-label") || "").slice(0, 80),
            text: (submit.textContent || "").trim().slice(0, 80),
            rect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
          } : null,
          images: collectAllImageSrcs().length,
          videos: collectAllVideoSrcs().length,
          failCards: countFailCards(),
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), href: location.href });
      }
      return;
    }

  });

  log("Content script ready (v" + AUTOFLOW_VERSION + ") on", location.href);
})();

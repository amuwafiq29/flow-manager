/**
 * ==========================================================
 *  TEST SCRIPT v4: Character Consistency - AUTOFLOW
 * ==========================================================
 * Perbaikan:
 *   - Ketik search per karakter (React-compatible)
 *   - Cari item hanya di dalam panel picker
 *   - Double click pada item aset
 * ==========================================================
 */
(async function () {
  var ASSET_NAME = "beruang_uppo"; // <<< GANTI SESUAI NAMA ASETMU

  var LOG = "🔬 [v4]";
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }

  function fireDoubleClick(el) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var o = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };

    el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, o, { pointerId: 1, pointerType: "mouse", buttons: 1 })));
    el.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, o, { buttons: 1, detail: 1 })));
    el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, o, { pointerId: 1, pointerType: "mouse", buttons: 0 })));
    el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0, detail: 1 })));
    el.dispatchEvent(new MouseEvent("click", Object.assign({}, o, { buttons: 0, detail: 1 })));

    el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, o, { pointerId: 1, pointerType: "mouse", buttons: 1 })));
    el.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, o, { buttons: 1, detail: 2 })));
    el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, o, { pointerId: 1, pointerType: "mouse", buttons: 0 })));
    el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0, detail: 2 })));
    el.dispatchEvent(new MouseEvent("click", Object.assign({}, o, { buttons: 0, detail: 2 })));
    el.dispatchEvent(new MouseEvent("dblclick", Object.assign({}, o, { buttons: 0, detail: 2 })));
  }

  // Ketik ke input React per karakter
  async function reactType(input, text) {
    input.focus();
    // Clear dulu
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      setter.call(input, input.value + ch);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      await sleep(50);
    }
  }

  console.log(LOG, "============================================");
  console.log(LOG, "Diagnostik v4 untuk: " + ASSET_NAME);
  console.log(LOG, "============================================");

  // ── STEP 1: Editor prompt ──
  var allEditors = Array.from(
    document.querySelectorAll('[data-slate-editor="true"][contenteditable="true"]')
  ).filter(isVisible);
  if (!allEditors.length) { console.error(LOG, "❌ Editor tidak ditemukan!"); return; }
  var mainEditor = allEditors.sort(function(a, b) {
    return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom;
  })[0];
  console.log(LOG, "STEP 1 ✅ Editor bottom:", Math.round(mainEditor.getBoundingClientRect().bottom));

  // ── STEP 2: Tombol '+' dekat prompt ──
  var editorBottom = mainEditor.getBoundingClientRect().bottom;
  var plusCandidates = [];
  document.querySelectorAll("button").forEach(function(b) {
    if (!isVisible(b)) return;
    var txt = (b.textContent || "").trim();
    var aria = (b.getAttribute("aria-label") || "").toLowerCase();
    if (txt.includes("add_2") || txt === "add" || aria.includes("add") || aria.includes("tambah")) {
      plusCandidates.push({ btn: b, dist: Math.abs(b.getBoundingClientRect().bottom - editorBottom), label: (aria || txt).substring(0, 30) });
    }
  });
  plusCandidates.sort(function(a, b) { return a.dist - b.dist; });
  if (!plusCandidates.length) { console.error(LOG, "❌ Tombol '+' tidak ditemukan!"); return; }
  console.log(LOG, "STEP 2 ✅ Tombol '+': " + plusCandidates[0].label + " (jarak=" + Math.round(plusCandidates[0].dist) + "px)");
  plusCandidates[0].btn.click();
  await sleep(1500);

  // ── STEP 3: Cari input pencarian "Telusuri aset" ──
  var searchInput = null;
  for (var a = 0; a < 15; a++) {
    searchInput = Array.from(document.querySelectorAll("input")).find(function(el) {
      return isVisible(el) && el.type !== "hidden" && /telusuri|search|cari/i.test(el.placeholder || "");
    });
    if (searchInput) break;
    await sleep(400);
  }
  if (!searchInput) { console.error(LOG, "❌ Input 'Telusuri aset' tidak ditemukan!"); return; }
  console.log(LOG, "STEP 3 ✅ Input: placeholder=\"" + searchInput.placeholder + "\"");

  // ── STEP 4: Cari PANEL PICKER (container parent dari search input) ──
  // Naik ke atas dari search input untuk menemukan panel/dialog
  var pickerPanel = searchInput.parentElement;
  for (var up = 0; up < 10; up++) {
    if (!pickerPanel.parentElement) break;
    pickerPanel = pickerPanel.parentElement;
    var panelRect = pickerPanel.getBoundingClientRect();
    // Panel picker biasanya berukuran besar dan memiliki banyak children
    if (panelRect.width > 300 && panelRect.height > 300 && pickerPanel.querySelectorAll("img").length > 1) {
      break;
    }
  }
  var panelImgCount = pickerPanel.querySelectorAll("img").length;
  console.log(LOG, "STEP 4 ✅ Panel picker: " + pickerPanel.tagName + " (ukuran: " + 
    Math.round(pickerPanel.getBoundingClientRect().width) + "x" + Math.round(pickerPanel.getBoundingClientRect().height) + 
    ", gambar: " + panelImgCount + ")");

  // ── STEP 5: Ketik nama aset per karakter ──
  console.log(LOG, "STEP 5 ⏳ Mengetik \"" + ASSET_NAME + "\" per karakter...");
  await reactType(searchInput, ASSET_NAME);
  await sleep(1500);
  console.log(LOG, "STEP 5 ✅ Selesai mengetik. Value: \"" + searchInput.value + "\"");

  // ── STEP 6: Cari item yang cocok DI DALAM PANEL PICKER ──
  console.log(LOG, "STEP 6 ⏳ Mencari item di dalam panel picker...");
  var matchedItem = null;

  for (var i = 0; i < 15; i++) {
    // Cari semua elemen yang punya gambar DI DALAM panel picker saja
    var panelImgs = Array.from(pickerPanel.querySelectorAll("img")).filter(isVisible);

    if (i === 0) {
      console.log(LOG, "  Gambar di panel picker: " + panelImgs.length);
    }

    // Untuk setiap gambar, cari parent yang berfungsi sebagai "item" (klikable)
    for (var j = 0; j < panelImgs.length; j++) {
      var img = panelImgs[j];
      // Naik ke parent terdekat yang mungkin berisi nama aset
      var itemEl = img.parentElement;
      for (var u = 0; u < 5; u++) {
        if (!itemEl) break;
        var itemText = itemEl.textContent.trim().toLowerCase();
        if (itemText.includes(ASSET_NAME.toLowerCase())) {
          // Pastikan ini bukan container terlalu besar
          var itemRect = itemEl.getBoundingClientRect();
          if (itemRect.height < 200 && itemRect.width < 400) {
            matchedItem = itemEl;
            console.log(LOG, "  ✅ Item ditemukan! Teks: \"" + itemEl.textContent.trim().substring(0, 50) + "\"");
            console.log(LOG, "    Ukuran: " + Math.round(itemRect.width) + "x" + Math.round(itemRect.height));
            console.log(LOG, "    Tag: " + itemEl.tagName + ", role: " + (itemEl.getAttribute("role") || "none"));
            break;
          }
        }
        itemEl = itemEl.parentElement;
      }
      if (matchedItem) break;
    }
    if (matchedItem) break;
    await sleep(400);
  }

  if (!matchedItem) {
    console.error(LOG, "❌ Item aset TIDAK ditemukan di panel picker!");
    console.log(LOG, "  💡 Mencoba fallback: cari berdasarkan alt pada gambar...");
    // Fallback: cari gambar yang alt-nya cocok
    var altMatch = Array.from(pickerPanel.querySelectorAll("img")).find(function(img) {
      return isVisible(img) && (img.alt || "").toLowerCase().includes(ASSET_NAME.toLowerCase());
    });
    if (altMatch) {
      matchedItem = altMatch.parentElement;
      console.log(LOG, "  ✅ Fallback berhasil via alt: \"" + altMatch.alt + "\"");
    } else {
      // Dump semua gambar di panel untuk debug
      console.log(LOG, "  📋 Semua gambar visible di panel:");
      Array.from(pickerPanel.querySelectorAll("img")).filter(isVisible).slice(0, 10).forEach(function(img, k) {
        var parent = img.parentElement;
        console.log(LOG, "    [" + k + "] alt=\"" + img.alt + "\" | parent text: \"" + (parent ? parent.textContent.trim().substring(0, 50) : "") + "\"");
      });
      return;
    }
  }

  // ── STEP 7: Snapshot sebelum double click ──
  var promptContainer = mainEditor.parentElement;
  for (var p = 0; p < 5; p++) {
    if (promptContainer.parentElement) promptContainer = promptContainer.parentElement;
  }
  var imgCountBefore = promptContainer.querySelectorAll("img").length;
  console.log(LOG, "STEP 7 📸 Snapshot SEBELUM: " + imgCountBefore + " gambar di area prompt");

  // ── STEP 8: DOUBLE CLICK item aset ──
  console.log(LOG, "STEP 8 ⏳ Double-click pada item...");
  
  // Klik pertama (select)
  matchedItem.click();
  await sleep(600);
  console.log(LOG, "  Klik pertama (select) ✓");
  
  // Double click
  fireDoubleClick(matchedItem);
  console.log(LOG, "  Double-click dispatched ✓");
  await sleep(800);

  // Jika masih terbuka, coba double click pada <img> langsung
  var innerImg = matchedItem.querySelector("img");
  if (innerImg && isVisible(searchInput)) {
    console.log(LOG, "  Picker masih terbuka, coba double-click pada <img> langsung...");
    fireDoubleClick(innerImg);
    await sleep(800);
  }

  // Jika masih terbuka, coba klik tombol "Tambahkan ke Perintah" sebagai fallback
  if (isVisible(searchInput)) {
    console.log(LOG, "  Picker masih terbuka, coba klik 'Tambahkan ke Perintah'...");
    var addBtn = Array.from(document.querySelectorAll("button")).find(function(b) {
      return isVisible(b) && /tambahkan ke perintah|add to prompt/i.test(b.textContent);
    });
    if (addBtn) {
      console.log(LOG, "  Tombol ditemukan: \"" + addBtn.textContent.trim().substring(0, 40) + "\"");
      // Coba React fiber click
      var fiberKey = Object.keys(addBtn).find(function(k) { return k.startsWith("__reactFiber$"); });
      if (fiberKey) {
        var fiber = addBtn[fiberKey];
        for (var d = 0; d < 20 && fiber; d++) {
          var props = fiber.memoizedProps || fiber.pendingProps || {};
          if (typeof props.onClick === "function") {
            console.log(LOG, "  React onClick di depth " + d + ", memanggil...");
            try {
              props.onClick(new MouseEvent("click", { bubbles: true }));
            } catch(e) { console.log(LOG, "  Error:", e.message); }
            break;
          }
          fiber = fiber.return;
        }
      }
      // Juga coba click biasa
      addBtn.click();
      fireDoubleClick(addBtn);
      await sleep(1000);
    }
  }

  // ── STEP 9: VERIFIKASI ──
  await sleep(1500);
  console.log(LOG, "STEP 9 ⏳ Verifikasi...");

  var pickerClosed = !isVisible(searchInput);
  var imgCountAfter = promptContainer.querySelectorAll("img").length;
  console.log(LOG, "  Picker tertutup: " + pickerClosed);
  console.log(LOG, "  Gambar di area prompt SEBELUM: " + imgCountBefore);
  console.log(LOG, "  Gambar di area prompt SESUDAH: " + imgCountAfter);

  // Cek thumbnail di sekitar kotak prompt  
  var nearPromptImgs = Array.from(document.querySelectorAll("img")).filter(function(img) {
    if (!isVisible(img)) return false;
    var imgRect = img.getBoundingClientRect();
    // Gambar harus dekat dengan prompt editor (dalam range 150px)
    return Math.abs(imgRect.bottom - editorBottom) < 150 || Math.abs(imgRect.top - editorBottom) < 150;
  });
  console.log(LOG, "  Gambar dekat prompt (<150px): " + nearPromptImgs.length);
  nearPromptImgs.forEach(function(img, k) {
    var ir = img.getBoundingClientRect();
    console.log(LOG, "    [" + k + "] " + Math.round(ir.width) + "x" + Math.round(ir.height) + " alt=\"" + (img.alt || "") + "\" src=" + (img.src || "").substring(0, 50));
  });

  if (imgCountAfter > imgCountBefore || nearPromptImgs.length > 0) {
    console.log(LOG, "✅✅✅ BERHASIL! Gambar terdeteksi di area prompt!");
  } else if (pickerClosed) {
    console.log(LOG, "⚠️ Picker tertutup tapi gambar belum terdeteksi.");
    console.log(LOG, "   Periksa manual: ada thumbnail kecil di kotak prompt?");
  } else {
    console.error(LOG, "❌❌❌ GAGAL. Picker masih terbuka, gambar tidak masuk.");
  }

  console.log(LOG, "============================================");
  console.log(LOG, "🏁 Diagnostik v4 selesai.");
  console.log(LOG, "============================================");
})();

const CHAR_DELAY_MS = 50;
// ── FlowManager diagnostic (tampilkan error JS di panel, bukan diam) ──
window.__fmDiag = [];
function __fmShowDiag(prefix, msg) {
  try {
    window.__fmDiag.push(prefix + msg);
    var el = document.getElementById("connMsg");
    if (el) el.textContent = (prefix + msg).slice(0, 140);
    var st = document.getElementById("status");
    if (st) st.textContent = (prefix + msg).slice(0, 200);
  } catch {}
}
window.addEventListener("error", function (e) {
  __fmShowDiag("JS error: ", String((e && e.message) || (e && e.error) || e));
});
window.addEventListener("unhandledrejection", function (e) {
  var r = e && e.reason;
  __fmShowDiag("Async error: ", String((r && r.message) || r));
});


// ─────────────────────────────────────────────
// Update banner
// ─────────────────────────────────────────────
const LATEST_VERSION = "1.4.1"; // ← bump this each release

const promptsEl        = document.getElementById("prompts");
const waitMinEl        = document.getElementById("waitMin");
const waitMaxEl        = document.getElementById("waitMax");
const statusEl         = document.getElementById("status");
const appEl            = document.getElementById("app");
const versionTagEl     = document.getElementById("versionTag");
const txtUploadEl      = document.getElementById("txtUpload");
const runBtn           = document.getElementById("run");
const continueBtn      = document.getElementById("continueBtn");
const stopBtn          = document.getElementById("stop");
const connBar          = document.getElementById("connBar");
const connDot          = document.getElementById("connDot");
const connMsg          = document.getElementById("connMsg");
const connLink         = document.getElementById("connLink");
const agentBar         = document.getElementById("agentBar");
const agentMsg         = document.getElementById("agentMsg");
const agentBadge       = document.getElementById("agentBadge");
const helpDialog       = document.getElementById("helpDialog");
const helpOpen         = document.getElementById("helpOpen");
const helpClose        = document.getElementById("helpClose");
const helpBodyEl       = document.getElementById("helpBody");
const listSection      = document.getElementById("listSection");
const promptListEl     = document.getElementById("promptList");
const listCountEl      = document.getElementById("listCount");
const downloadFolderEl    = document.getElementById("downloadFolder");
const autoDownloadToggle  = document.getElementById("autoDownloadToggle");
const serialToggleEl   = document.getElementById("serialToggle");
const langSelectEl     = document.getElementById("langSelect");
const openDlSettings   = document.getElementById("openDlSettings");

// ─────────────────────────────────────────────
// Version from manifest
const { version } = chrome.runtime.getManifest();
if (versionTagEl) versionTagEl.textContent = `v${version}`;

// Show update banner if installed version is behind LATEST_VERSION
// Only shown once — dismissed state saved in storage per version
(function checkUpdateBanner() {
  const updateBar     = document.getElementById("updateBar");
  const updateDismiss = document.getElementById("updateDismiss");
  if (!updateBar) return;

  function versionIsOlder(installed, latest) {
    const a = installed.split(".").map(Number);
    const b = latest.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) < (b[i] || 0)) return true;
      if ((a[i] || 0) > (b[i] || 0)) return false;
    }
    return false;
  }

  if (!versionIsOlder(version, LATEST_VERSION)) return; // already up to date

  chrome.storage.local.get("zapUpdateDismissed", (r) => {
    if (r.zapUpdateDismissed === LATEST_VERSION) return; // already dismissed for this version
    updateBar.style.display = "";
  });

  updateDismiss.addEventListener("click", () => {
    updateBar.style.display = "none";
    chrome.storage.local.set({ zapUpdateDismissed: LATEST_VERSION });
  });
})();

// ─────────────────────────────────────────────
// TXT file upload
// ─────────────────────────────────────────────
if (txtUploadEl) {
  txtUploadEl.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result || "";
      // Each non-empty line becomes a prompt
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      promptsEl.value = lines.join("\n");
      rebuildList();
      persist();
    };
    reader.readAsText(file);
    txtUploadEl.value = ""; // reset so same file can be re-uploaded
  });
}

// ─────────────────────────────────────────────
// i18n strings
// ─────────────────────────────────────────────
const LANGS = {
  en: {
    promptQueueLabel:  "Prompt queue",
    promptQueueHint:   "One prompt per line · list updates as you type",
    queueTitle:        "Queue",
    promptCount:       (n) => `${n} prompt${n === 1 ? "" : "s"}`,
    delayFrom:         "Random delay from",
    delayTo:           "To",
    delaySec:          "sec",
    downloadFolderLabel: "Download folder",
    autoDownload:      "Auto-save",
    checkPage:         "Check page",
    runQueue:          "Start Generation",
    stop:              "Stop",
    statusPending:     "Pending",
    statusGenerating:  "Generating…",
    statusDone:        "Done ✓",
    statusFailed:      "Failed ✗",
    statusStopped:     "Skipped",
    helpTitle:         "Getting Started",
    helpClose:         "Got it",
    helpDelayTitle:    "Random delay",
    helpDelayBody:     "After each generation, AUTOFLOW waits a random number of seconds within your set range before starting the next prompt.",
    helpBody: `
      <p class="lede">① Go to your Google Flow project:<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② Enter your prompts below — one per line. Your queue updates as you type.</p>
      <p class="lede">③ Click <strong>Run queue</strong>. AUTOFLOW generates each image one at a time and downloads it automatically.</p>`,
    placeholder: "A red bicycle on a rainy street\nA watercolor fox in a forest\nNeon alley at dusk, cinematic",
    msgStarting:    (n)   => `Starting ${n} prompt(s)…`,
    msgSubmitting:  (i,n) => `Submitting prompt ${i} of ${n}…`,
    msgWaiting:     (i)   => `Prompt ${i} submitted — waiting for generation…`,
    msgDownloading: (i)   => `Prompt ${i} done ✓ — downloading image…`,
    msgDone:        (i)   => `Next prompt in ${i}s…`,
    msgAllDone:     (n)   => `✓ All ${n} prompt(s) generated.`,
    msgPartDone:    (c,n) => `Done: ${c} of ${n} generated.`,
    msgStopped:     "Stopped.",
    msgChecking:    "Checking…",
    msgConnected:   (h)   => `Connected: ${h}`,
    msgNoTab:       "No active tab.",
    msgNotReady:    "Content script not ready. Open a Flow project tab and refresh.",
    msgTimeout:     (i)   => `Prompt ${i} timed out.`,
    msgError:       (i,e) => `Error on prompt ${i}: ${e}`,
    msgAddPrompt:   "Add at least one prompt.",
    msgOpenProject: "Please open a Flow project page first (flow.google or labs.google/fx/tools/flow).",
  },
  id: {
    promptQueueLabel:  "Antrian prompt",
    promptQueueHint:   "Satu prompt per baris · daftar diperbarui saat Anda mengetik",
    queueTitle:        "Antrian",
    promptCount:       (n) => `${n} prompt`,
    delayFrom:         "Jeda acak dari",
    delayTo:           "hingga",
    delaySec:          "dtk",
    downloadFolderLabel: "Folder unduhan",
    autoDownload:      "Simpan otomatis",
    checkPage:         "Cek halaman",
    runQueue:          "Jalankan Antrian",
    stop:              "Berhenti",
    statusPending:     "Menunggu",
    statusGenerating:  "Membuat...",
    statusDone:        "Selesai ✓",
    statusFailed:      "Gagal ✗",
    statusStopped:     "Dilewati",
    helpTitle:         "Mulai Menggunakan",
    helpClose:         "Mengerti",
    helpDelayTitle:    "Jeda acak",
    helpDelayBody:     "Setelah setiap pembuatan selesai, AUTOFLOW akan menunggu secara acak dalam rentang yang Anda atur sebelum memulai prompt berikutnya.",
    helpBody: `
      <p class="lede">① Buka proyek Google Flow Anda:<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② Masukkan prompt Anda di bawah — satu per baris. Daftar diperbarui saat Anda mengetik.</p>
      <p class="lede">③ Klik <strong>Jalankan Antrian</strong>. AUTOFLOW membuat gambar satu per satu dan mengunduhnya otomatis.</p>`,
    placeholder: "Sepeda merah di jalanan yang hujan\nRubah cat air di hutan\nGang neon saat senja, sinematik",
    msgStarting:    (n)   => `Memulai ${n} prompt…`,
    msgSubmitting:  (i,n) => `Mengirim prompt ${i} dari ${n}…`,
    msgWaiting:     (i)   => `Prompt ${i} terkirim — menunggu pembuatan…`,
    msgDownloading: (i)   => `Prompt ${i} selesai ✓ — mengunduh gambar…`,
    msgDone:        (i)   => `Prompt berikutnya dalam ${i}dtk…`,
    msgAllDone:     (n)   => `✓ Semua ${n} prompt selesai dibuat.`,
    msgPartDone:    (c,n) => `Selesai: ${c} dari ${n} dibuat.`,
    msgStopped:     "Dihentikan.",
    msgChecking:    "Memeriksa…",
    msgConnected:   (h)   => `Terhubung: ${h}`,
    msgNoTab:       "Tidak ada tab aktif.",
    msgNotReady:    "Script belum siap. Buka tab proyek Flow dan muat ulang.",
    msgTimeout:     (i)   => `Waktu habis untuk prompt ${i}.`,
    msgError:       (i,e) => `Error pada prompt ${i}: ${e}`,
    msgAddPrompt:   "Tambahkan setidaknya satu prompt.",
    msgOpenProject: "Harap buka halaman proyek Flow terlebih dahulu (flow.google atau labs.google/fx/tools/flow).",
  },
  vi: {
    promptQueueLabel:  "Hàng đợi prompt",
    promptQueueHint:   "Mỗi dòng một prompt · danh sách cập nhật khi bạn gõ",
    queueTitle:        "Hàng đợi",
    promptCount:       (n) => `${n} prompt`,
    delayFrom:         "Độ trễ ngẫu nhiên từ",
    delayTo:           "đến",
    delaySec:          "giây",
    downloadFolderLabel: "Thư mục tải xuống",
    autoDownload:      "Tự động lưu",
    checkPage:         "Kiểm tra trang",
    runQueue:          "Chạy hàng đợi",
    stop:              "Dừng",
    statusPending:     "Chờ",
    statusGenerating:  "Đang tạo…",
    statusDone:        "Hoàn thành ✓",
    statusFailed:      "Lỗi ✗",
    statusStopped:     "Đã bỏ qua",
    helpTitle:         "Hướng dẫn sử dụng",
    helpClose:         "Đã hiểu",
    helpDelayTitle:    "Độ trễ ngẫu nhiên",
    helpDelayBody:     "Sau mỗi lần tạo ảnh, AUTOFLOW chờ một khoảng thời gian ngẫu nhiên trong phạm vi bạn đặt trước khi bắt đầu prompt tiếp theo.",
    helpBody: `
      <p class="lede">① Truy cập dự án Google Flow của bạn:<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② Nhập prompt bên dưới — mỗi dòng một cái. Danh sách cập nhật ngay khi bạn gõ.</p>
      <p class="lede">③ Nhấn <strong>Chạy hàng đợi</strong>. AUTOFLOW tạo từng ảnh một và tự động tải xuống.</p>`,
    placeholder: "Xe đạp đỏ trên phố mưa\nCáo màu nước trong rừng\nHẻm neon lúc hoàng hôn",
    msgStarting:    (n)   => `Đang bắt đầu ${n} prompt…`,
    msgSubmitting:  (i,n) => `Đang gửi prompt ${i}/${n}…`,
    msgWaiting:     (i)   => `Đã gửi prompt ${i} — đang chờ tạo ảnh…`,
    msgDownloading: (i)   => `Prompt ${i} xong ✓ — đang tải xuống…`,
    msgDone:        (i)   => `Prompt tiếp theo sau ${i} giây…`,
    msgAllDone:     (n)   => `✓ Đã hoàn thành ${n} prompt.`,
    msgPartDone:    (c,n) => `Xong: ${c}/${n} prompt.`,
    msgStopped:     "Đã dừng.",
    msgChecking:    "Đang kiểm tra…",
    msgConnected:   (h)   => `Đã kết nối: ${h}`,
    msgNoTab:       "Không có tab nào đang mở.",
    msgNotReady:    "Chưa sẵn sàng. Mở trang dự án Flow và làm mới.",
    msgTimeout:     (i)   => `Prompt ${i} hết thời gian chờ.`,
    msgError:       (i,e) => `Lỗi prompt ${i}: ${e}`,
    msgAddPrompt:   "Hãy thêm ít nhất một prompt.",
    msgOpenProject: "Vui lòng mở trang dự án Flow trước (URL phải chứa /project/).",
  },
  zh: {
    promptQueueLabel:  "提示词队列",
    promptQueueHint:   "每行一个提示词 · 输入即更新",
    queueTitle:        "队列",
    promptCount:       (n) => `${n} 个提示词`,
    delayFrom:         "随机延迟从",
    delayTo:           "到",
    delaySec:          "秒",
    downloadFolderLabel: "下载文件夹",
    autoDownload:      "自动保存",
    checkPage:         "检查页面",
    runQueue:          "运行队列",
    stop:              "停止",
    statusPending:     "等待中",
    statusGenerating:  "生成中…",
    statusDone:        "完成 ✓",
    statusFailed:      "失败 ✗",
    statusStopped:     "已跳过",
    helpTitle:         "使用指南",
    helpClose:         "明白了",
    helpDelayTitle:    "随机延迟",
    helpDelayBody:     "每次生成完成后，AUTOFLOW 会在您设定的范围内随机等待一段时间，然后开始下一个提示词。",
    helpBody: `
      <p class="lede">① 前往您的 Google Flow 项目：<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② 在下方输入提示词 — 每行一个，列表即时更新。</p>
      <p class="lede">③ 点击<strong>运行队列</strong>。AUTOFLOW 逐一生成图像并自动下载。</p>`,
    placeholder: "雨中的红色自行车\n森林里的水彩狐狸\n黄昏时的霓虹小巷",
    msgStarting:    (n)   => `开始处理 ${n} 个提示词…`,
    msgSubmitting:  (i,n) => `正在提交第 ${i}/${n} 个提示词…`,
    msgWaiting:     (i)   => `第 ${i} 个已提交 — 等待生成…`,
    msgDownloading: (i)   => `第 ${i} 个完成 ✓ — 正在下载…`,
    msgDone:        (i)   => `${i} 秒后开始下一个…`,
    msgAllDone:     (n)   => `✓ 全部 ${n} 个提示词已完成。`,
    msgPartDone:    (c,n) => `完成：${c}/${n} 个。`,
    msgStopped:     "已停止。",
    msgChecking:    "检查中…",
    msgConnected:   (h)   => `已连接：${h}`,
    msgNoTab:       "没有活动标签页。",
    msgNotReady:    "内容脚本未就绪。请打开 Flow 项目页面并刷新。",
    msgTimeout:     (i)   => `第 ${i} 个提示词超时。`,
    msgError:       (i,e) => `第 ${i} 个出错：${e}`,
    msgAddPrompt:   "请至少添加一个提示词。",
    msgOpenProject: "请先打开 Flow 项目页面（URL 需包含 /project/）。",
  },
  ko: {
    promptQueueLabel:  "프롬프트 큐",
    promptQueueHint:   "한 줄에 하나씩 · 입력하면 목록이 즉시 업데이트됩니다",
    queueTitle:        "큐",
    promptCount:       (n) => `${n}개 프롬프트`,
    delayFrom:         "무작위 지연",
    delayTo:           "~",
    delaySec:          "초",
    downloadFolderLabel: "다운로드 폴더",
    autoDownload:      "자동 저장",
    checkPage:         "페이지 확인",
    runQueue:          "큐 실행",
    stop:              "정지",
    statusPending:     "대기 중",
    statusGenerating:  "생성 중…",
    statusDone:        "완료 ✓",
    statusFailed:      "실패 ✗",
    statusStopped:     "건너뜀",
    helpTitle:         "시작하기",
    helpClose:         "확인",
    helpDelayTitle:    "무작위 지연",
    helpDelayBody:     "각 생성 완료 후 AUTOFLOW는 설정한 범위 내에서 무작위 시간 동안 대기한 후 다음 프롬프트를 시작합니다.",
    helpBody: `
      <p class="lede">① Google Flow 프로젝트로 이동하세요:<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② 아래에 프롬프트를 입력하세요 — 한 줄에 하나씩. 입력하는 즉시 목록이 업데이트됩니다.</p>
      <p class="lede">③ <strong>큐 실행</strong>을 클릭하세요. AUTOFLOW가 이미지를 하나씩 생성하고 자동으로 다운로드합니다.</p>`,
    placeholder: "빗속의 빨간 자전거\n숲 속의 수채화 여우\n황혼의 네온 골목",
    msgStarting:    (n)   => `${n}개 프롬프트 시작 중…`,
    msgSubmitting:  (i,n) => `${n}개 중 ${i}번째 제출 중…`,
    msgWaiting:     (i)   => `${i}번째 제출됨 — 생성 대기 중…`,
    msgDownloading: (i)   => `${i}번째 완료 ✓ — 다운로드 중…`,
    msgDone:        (i)   => `${i}초 후 다음 프롬프트…`,
    msgAllDone:     (n)   => `✓ ${n}개 프롬프트 모두 완료.`,
    msgPartDone:    (c,n) => `완료: ${n}개 중 ${c}개.`,
    msgStopped:     "정지됨.",
    msgChecking:    "확인 중…",
    msgConnected:   (h)   => `연결됨: ${h}`,
    msgNoTab:       "활성 탭이 없습니다.",
    msgNotReady:    "준비되지 않았습니다. Flow 프로젝트 탭을 열고 새로고침하세요.",
    msgTimeout:     (i)   => `${i}번째 프롬프트 시간 초과.`,
    msgError:       (i,e) => `${i}번째 오류: ${e}`,
    msgAddPrompt:   "프롬프트를 하나 이상 추가하세요.",
    msgOpenProject: "먼저 Flow 프로젝트 페이지를 여세요 (URL에 /project/ 포함).",
  },
  es: {
    promptQueueLabel:  "Cola de prompts",
    promptQueueHint:   "Un prompt por línea · la lista se actualiza al escribir",
    queueTitle:        "Cola",
    promptCount:       (n) => `${n} prompt${n === 1 ? "" : "s"}`,
    delayFrom:         "Demora aleatoria de",
    delayTo:           "a",
    delaySec:          "seg",
    downloadFolderLabel: "Carpeta de descarga",
    autoDownload:      "Guardado auto",
    checkPage:         "Verificar página",
    runQueue:          "Ejecutar cola",
    stop:              "Detener",
    statusPending:     "Pendiente",
    statusGenerating:  "Generando…",
    statusDone:        "Listo ✓",
    statusFailed:      "Error ✗",
    statusStopped:     "Omitido",
    helpTitle:         "Cómo empezar",
    helpClose:         "Entendido",
    helpDelayTitle:    "Demora aleatoria",
    helpDelayBody:     "Tras cada generación, AUTOFLOW espera un tiempo aleatorio dentro del rango configurado antes de iniciar el siguiente prompt.",
    helpBody: `
      <p class="lede">① Ve a tu proyecto de Google Flow:<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② Escribe tus prompts abajo — uno por línea. La cola se actualiza al instante.</p>
      <p class="lede">③ Haz clic en <strong>Ejecutar cola</strong>. AUTOFLOW genera cada imagen una a una y la descarga automáticamente.</p>`,
    placeholder: "Una bicicleta roja en una calle lluviosa\nUn zorro en acuarela en el bosque\nCallejón neón al atardecer",
    msgStarting:    (n)   => `Iniciando ${n} prompt(s)…`,
    msgSubmitting:  (i,n) => `Enviando prompt ${i} de ${n}…`,
    msgWaiting:     (i)   => `Prompt ${i} enviado — esperando generación…`,
    msgDownloading: (i)   => `Prompt ${i} listo ✓ — descargando…`,
    msgDone:        (i)   => `Siguiente en ${i}s…`,
    msgAllDone:     (n)   => `✓ ${n} prompt(s) generados.`,
    msgPartDone:    (c,n) => `Hecho: ${c} de ${n}.`,
    msgStopped:     "Detenido.",
    msgChecking:    "Verificando…",
    msgConnected:   (h)   => `Conectado: ${h}`,
    msgNoTab:       "No hay pestaña activa.",
    msgNotReady:    "Script no listo. Abre la página del proyecto Flow y recarga.",
    msgTimeout:     (i)   => `Prompt ${i} superó el tiempo límite.`,
    msgError:       (i,e) => `Error en prompt ${i}: ${e}`,
    msgAddPrompt:   "Añade al menos un prompt.",
    msgOpenProject: "Abre primero una página de proyecto Flow (URL debe contener /project/).",
  },
  ja: {
    promptQueueLabel:  "プロンプトキュー",
    promptQueueHint:   "1行に1つ · 入力するとリストが更新されます",
    queueTitle:        "キュー",
    promptCount:       (n) => `${n}件`,
    delayFrom:         "ランダム遅延",
    delayTo:           "〜",
    delaySec:          "秒",
    downloadFolderLabel: "ダウンロードフォルダ",
    autoDownload:      "自動保存",
    checkPage:         "ページ確認",
    runQueue:          "キュー実行",
    stop:              "停止",
    statusPending:     "待機中",
    statusGenerating:  "生成中…",
    statusDone:        "完了 ✓",
    statusFailed:      "失敗 ✗",
    statusStopped:     "スキップ",
    helpTitle:         "はじめかた",
    helpClose:         "わかった",
    helpDelayTitle:    "ランダム遅延",
    helpDelayBody:     "各生成が完了した後、AUTOFLOWは設定した範囲内でランダムな秒数を待ってから次のプロンプトを開始します。",
    helpBody: `
      <p class="lede">① Google Flowプロジェクトへ移動:<br/>
        <a class="path-link" href="https://flow.google/" target="_blank">
          https://flow.google/
        </a>
      </p>
      <p class="lede">② プロンプトを1行ずつ入力。キューはリアルタイムで更新されます。</p>
      <p class="lede">③ <strong>キュー実行</strong>をクリック。AUTOFLOWが1枚ずつ画像を生成・自動ダウンロードします。</p>`,
    placeholder: "雨の日の赤い自転車\n森の中の水彩画の狐\n夕暮れのネオン路地",
    msgStarting:    (n)   => `${n}件のプロンプトを開始…`,
    msgSubmitting:  (i,n) => `プロンプト ${i}/${n} を送信中…`,
    msgWaiting:     (i)   => `プロンプト ${i} 送信済 — 生成を待機中…`,
    msgDownloading: (i)   => `プロンプト ${i} 完了 ✓ — ダウンロード中…`,
    msgDone:        (i)   => `次のプロンプトまで ${i} 秒…`,
    msgAllDone:     (n)   => `✓ ${n}件すべて完了。`,
    msgPartDone:    (c,n) => `完了: ${n}件中${c}件。`,
    msgStopped:     "停止しました。",
    msgChecking:    "確認中…",
    msgConnected:   (h)   => `接続済み: ${h}`,
    msgNoTab:       "アクティブなタブがありません。",
    msgNotReady:    "準備ができていません。Flowプロジェクトを開いて更新してください。",
    msgTimeout:     (i)   => `プロンプト ${i} がタイムアウトしました。`,
    msgError:       (i,e) => `プロンプト ${i} エラー: ${e}`,
    msgAddPrompt:   "プロンプトを1つ以上入力してください。",
    msgOpenProject: "先にFlowプロジェクトページを開いてください（URLに /project/ が必要）。",
  },
};

// ─────────────────────────────────────────────
// Language / i18n
// ─────────────────────────────────────────────
let currentLang = "en";

function t(key, ...args) {
  const s = LANGS[currentLang]?.[key] ?? LANGS.en[key];
  return typeof s === "function" ? s(...args) : (s ?? key);
}

function applyLanguage() {
  const L = LANGS[currentLang] || LANGS.en;

  // Static data-i18n elements
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const val = L[key];
    if (val && typeof val === "string") el.textContent = val;
  });

  // Help body (HTML)
  if (helpBodyEl) helpBodyEl.innerHTML = L.helpBody || LANGS.en.helpBody;

  // Rebuild list count label
  rebuildList();
}

langSelectEl.addEventListener("change", () => {
  currentLang = langSelectEl.value;
  applyLanguage();
  chrome.storage.local.set({ zapLang: currentLang });
});

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomWait(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
}

function setStatus(text) { statusEl.textContent = text; }

let flowTabId     = null; // locked-in tab ID during generation
let resumeFromIdx = null; // index to resume from after a stop/failure

function setInputsDisabled(disabled) {
  promptsEl.disabled        = disabled;
  serialToggleEl.disabled   = disabled;
  downloadFolderEl.disabled  = disabled;
  openDlSettings.disabled    = disabled;
  autoDownloadToggle.disabled = disabled;
  waitMinEl.disabled        = disabled;
  waitMaxEl.disabled        = disabled;
  txtUploadEl.disabled      = disabled;
  const opacity = disabled ? "0.45" : "";
  [promptsEl, serialToggleEl, downloadFolderEl, openDlSettings, waitMinEl, waitMaxEl, txtUploadEl]
    .forEach(el => el.style.opacity = opacity);
  const uploadLabel = document.querySelector(".btn-txt-upload");
  if (uploadLabel) uploadLabel.style.opacity = opacity;
}

function showContinue(fromIndex) {
  resumeFromIdx = fromIndex;
  continueBtn.style.display = "";
  continueBtn.textContent   = `▶ Continue from #${fromIndex + 1}`;
  runBtn.disabled = true; // keep Start Generation disabled
}

function hideContinue() {
  resumeFromIdx = null;
  continueBtn.style.display = "none";
}

async function getActiveTab() {
  const [tab] = await __fmTabsQuery({ active: true, currentWindow: true });
  return tab;
}

// Di WebView2 embedded (FlowManager), "active tab" sering = panel extension
// itu sendiri (panel yang terakhir diklik). Cari tab Flow berdasarkan URL.
async function findFlowTab() {
  try {
    const tabs = await __fmTabsQuery({});
    return tabs.find((t) => t.url && FLOW_BASE_RE.test(t.url)) || null;
  } catch {
    return null;
  }
}

// Try to (re-)inject selectors.js + content.js into a Flow tab, then ping.
// This self-heals the classic "Content script not ready" loop that happens
// after the extension updates (old content-script context is gone until the
// tab refreshes) or after SPA navigation.
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["selectors.js", "content.js"],
    });
    await sleep(600);
    return await chrome.tabs.sendMessage(tabId, { type: "FLOW_BATCH_PING" });
  } catch (e) {
    return { __injectError: String(e?.message || e) };
  }
}

async function sendToFlowTab(message, { retries = 5, retryDelayMs = 3000 } = {}) {
  // During generation use the saved tab ID so switching tabs doesn't break it
  let tabId = flowTabId;
  let tab = null;
  if (tabId) {
    try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
    if (!tab) flowTabId = null; // locked tab was closed — fall back to active tab
  }
  if (!flowTabId) {
    tab = (await findFlowTab()) || (await getActiveTab());
    tabId = tab?.id;
  }
  if (!tabId) { setStatus(t("msgNoTab")); return null; }

  // Don't spin the retry loop when we're not even on a Flow page.
  const url = tab?.url || (await findFlowTab())?.url || (await getActiveTab())?.url || "";
  if (url && !FLOW_BASE_RE.test(url)) {
    setStatus(t("msgOpenProject"));
    return null;
  }

  let injected = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      const err = String(e?.message || e);

      // First failure: try self-healing re-injection once (no refresh needed).
      if (!injected) {
        injected = true;
        setStatus("Injecting helper into Flow tab…");
        const probe = await ensureInjected(tabId);
        if (probe && !probe.__injectError) return await chrome.tabs.sendMessage(tabId, message);
        const injectErr = probe?.__injectError || err;
        // Host permission / site-access problem — retrying won't help.
        if (/permission|access|host|match|No tab with id/i.test(injectErr)) {
          setStatus("Aktifkan akses situs untuk ekstensi ini di flow.google lalu refresh tab Flow. (chrome://extensions → AUTOFLOW → Site access → On all sites)");
          return null;
        }
        // Otherwise fall through to normal reload-wait retries.
      }

      if (attempt === retries) {
        setStatus(t("msgNotReady"));
        return null;
      }
      // Content script likely reloading — wait and retry
      setStatus(`Page reloading… retrying in ${Math.round(retryDelayMs / 1000)}s (${attempt + 1}/${retries})`);
      await sleep(retryDelayMs);
    }
  }
}

// ─────────────────────────────────────────────
// Help dialog
// ─────────────────────────────────────────────
if (helpOpen  && helpDialog?.showModal) helpOpen.addEventListener("click",  () => helpDialog.showModal());
if (helpClose && helpDialog?.close)     helpClose.addEventListener("click", () => helpDialog.close());

// ─────────────────────────────────────────────
// Auto-download settings link
// ─────────────────────────────────────────────
openDlSettings?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
});

// ─────────────────────────────────────────────
// html escape
// ─────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────
// Prompt list
// ─────────────────────────────────────────────
let promptStatuses = [];
let isRunning = false;

function statusLabel(s) {
  return t("status" + s.charAt(0).toUpperCase() + s.slice(1));
}

function parsePrompts() {
  return promptsEl.value.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

function rebuildList() {
  const lines = parsePrompts();
  if (!lines.length) { listSection.style.display = "none"; return; }

  const prev = promptStatuses;
  promptStatuses = lines.map((text, i) => ({
    text,
    status: (prev[i] && prev[i].text === text) ? prev[i].status : "pending",
  }));

  renderList();
  listSection.style.display = "";
  const n = lines.length;
  listCountEl.textContent = t("promptCount", n);
}

function renderList() {
  promptListEl.innerHTML = "";
  const ccOn = charConsistencyToggle?.checked;
  promptStatuses.forEach((item, i) => {
    const names = ccOn ? extractAssetNames(item.text) : [];
    const badgesHtml = names.length
      ? `<span class="prompt-ref-badges">${names.map(n =>
          `<span class="prompt-ref-badge" title="${escHtml(n)}">${escHtml(n)}</span>`
        ).join("")}</span>`
      : "";
    const row = document.createElement("div");
    row.className = "prompt-item" + statusClass(item.status);
    row.id = `pr-${i}`;
    row.innerHTML =
      `<span class="prompt-num">${i + 1}</span>` +
      `<span class="prompt-text" title="${escHtml(item.text)}">${escHtml(item.text)}</span>` +
      badgesHtml +
      `<span class="prompt-status s-${item.status}">${statusLabel(item.status)}</span>`;
    promptListEl.appendChild(row);
  });
}

function statusClass(s) {
  return s === "generating" ? " is-running"
       : s === "done"       ? " is-done"
       : s === "failed"     ? " is-failed"
       : s === "stopped"    ? " is-stopped" : "";
}

function updateStatus(index, status) {
  if (index < 0 || index >= promptStatuses.length) return;
  promptStatuses[index].status = status;
  const row = document.getElementById(`pr-${index}`);
  if (!row) return;
  row.className = "prompt-item" + statusClass(status);
  const badge = row.querySelector(".prompt-status");
  if (badge) { badge.className = `prompt-status s-${status}`; badge.textContent = statusLabel(status); }
  if (status === "generating") row.scrollIntoView({ block: "nearest" });
}

promptsEl.addEventListener("input", () => {
  if (!isRunning) {
    rebuildList();
    hideContinue();        // clear resume state when prompts change
    runBtn.disabled = !connBar.classList.contains("is-connected") || agentModeOn;
  }
});

// ─────────────────────────────────────────────
// Countdown
// ─────────────────────────────────────────────
async function countdown(seconds) {
  for (let s = seconds; s > 0 && isRunning; s--) {
    setStatus(t("msgDone", s));
    await sleep(1000);
  }
}

// ─────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────
function safePromptName(text) {
  return text
    .slice(0, 30)
    .replace(/:/g, "-")            // ALL colons → dash (: not allowed in filenames)
    .replace(/\s+/g, "_")
    .replace(/[^\w_\[\]\-]/g, "")  // keep [ ] - along with word chars
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 25);
}

// Timestamp prefix like [00:00] or [00:01:30] at the start of a prompt.
// Returned filename-safe: "[00-00]" / "[00-01-30]" (colon → dash).
function extractTimestamp(text) {
  const m = String(text).match(/^\[((?:\d+:)+\d+)\]/);
  return m ? `[${m[1].replace(/:/g, "-")}]` : "";
}

async function downloadGeneratedImages(newUrls, serialNum, promptText) {
  const folder    = (downloadFolderEl.value || "autoflow-img").replace(/[/\\]+$/, "");
  const serial    = String(serialNum).padStart(2, "0");
  const useSerial = serialToggleEl.checked;
  // Timestamp always leads the filename when the prompt has one,
  // then the asset name (e.g. wafiq_stikmen) or a descriptive slug.
  const ts       = extractTimestamp(promptText);
  const body     = String(promptText).replace(/^\[(?:\d+:)+\d+\]\s*/, "");
  const detected = extractAssetNames(promptText);
  let name = detected.length ? detected[0] : safePromptName(body);
  if (!name) name = "prompt";
  if (ts) name = `${ts}_${name}`;

  for (let j = 0; j < newUrls.length; j++) {
    let url = newUrls[j];
    if (!url.startsWith("http")) url = "https://labs.google" + url;
    const suffix   = newUrls.length > 1 ? `_${j + 1}` : "";
    // Timestamped prompts already sort by time — no serial needed.
    // Serial only applies to prompts WITHOUT a timestamp.
    const baseName = (useSerial && !ts) ? `${serial}_${name}` : name;
    const filename = `${folder}/${baseName}${suffix}.jpg`;
    try { await chrome.downloads.download({ url, filename, saveAs: false }); }
    catch (e) { console.warn("[AUTOFLOW] Download failed:", e); }
  }
}

// ─────────────────────────────────────────────
// Auto connection check
// ─────────────────────────────────────────────
const FLOW_BASE    = "https://flow.google/";
const FLOW_PROJECT = "https://flow.google/";
// Matches:
//   - new home: flow.google/* (+ .com + subdomains)
//   - classic: labs.google/fx/tools/flow/* + localized /fx/<locale>/tools/flow/*
const FLOW_PROJECT_RE = /(flow\.google\.com|flow\.google\/?.*(project|session|library)?|labs\.google\/fx(?:\/[a-z]{2,}(?:-[a-zA-Z]{2,})?)?\/tools\/flow\/project\/)/;
const FLOW_BASE_RE    = /(flow\.google|labs\.google\/fx(?:\/[a-z]{2,}(?:-[a-zA-Z]{2,})?)?\/tools\/flow)/;

let agentModeOn = false;

async function checkAgentMode() {
  const res = await sendToFlowTab({ type: "FLOW_GET_AGENT_MODE" });
  if (!res?.found) { agentBar.style.display = "none"; return; }

  agentModeOn = res.isOn;
  agentBar.style.display = "";

  if (res.isOn) {
    agentBar.className = "agent-bar is-on";
    agentMsg.textContent = "Turn off Agent mode to start generation";
    agentBadge.textContent = "ON";
    agentBadge.className = "agent-badge is-on";
    if (!isRunning) runBtn.disabled = true;
  } else {
    agentBar.className = "agent-bar is-off";
    agentMsg.textContent = "Agent mode";
    agentBadge.textContent = "OFF";
    agentBadge.className = "agent-badge is-off";
    if (!isRunning) runBtn.disabled = false;
  }
}

function setConnected() {
  connBar.className = "conn-bar is-connected";
  connMsg.textContent = "Connected to Google Flow project";
  connLink.style.display = "none";
  if (!isRunning) runBtn.disabled = false;
  checkAgentMode();
}

function setOpenProject() {
  connBar.className = "conn-bar is-warn";
  connMsg.textContent = "Open a project to continue";
  connLink.style.display = "none";
  agentBar.style.display = "none";
  if (!isRunning) runBtn.disabled = true;
}

function setGoToFlow() {
  connBar.className = "conn-bar is-off";
  connMsg.textContent = "Not on Google Flow";
  connLink.style.display = "";
  connLink.textContent = "Go to Google Flow →";
  connLink.href = FLOW_BASE;
  agentBar.style.display = "none";
  if (!isRunning) runBtn.disabled = true;
}

async function __fmTabsQuery(q, ms) {
  ms = ms || 5000;
  var timeout = new Promise(function (_, rej) {
    setTimeout(function () { rej(new Error("tabs.query timeout")); }, ms);
  });
  return Promise.race([chrome.tabs.query(q), timeout]);
}

async function checkConnection() {
  try { return await __fmCheckConnection(); }
  catch (e) { __fmShowDiag("Check failed: ", String((e && e.message) || e)); }
}

async function __fmCheckConnection() {
  const tab = (await findFlowTab()) || (await getActiveTab());
  const url = tab?.url || "";
  if (FLOW_PROJECT_RE.test(url)) {
    setConnected();
    // Silent ping: verify injection without spamming the status bar.
    // Real errors surface when the user presses Start (sendToFlowTab
    // self-heals via scripting injection there).
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "FLOW_BATCH_PING" });
      if (!isRunning && statusEl.textContent === t("msgNotReady")) setStatus("");
    } catch {
      if (!isRunning) setStatus(t("msgNotReady"));
    }
  } else if (FLOW_BASE_RE.test(url)) {
    // On flow.google / labs.google …/tools/flow but no project open
    setOpenProject();
  } else {
    // Completely different URL
    setGoToFlow();
  }
}

// Click the connection bar to re-check manually (e.g. after refresh).
connBar.style.cursor = "pointer";
connBar.title = "Click to re-check connection";
connBar.addEventListener("click", () => {
  setStatus(t("msgChecking"));
  checkConnection();
});

// Check on load
checkConnection();

// Poll agent mode every 3 seconds when connected
setInterval(() => { if (connBar.classList.contains("is-connected")) checkAgentMode(); }, 3000);


// Re-check whenever the active tab URL changes
chrome.tabs.onActivated.addListener(() => checkConnection());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && FLOW_BASE_RE.test(changeInfo.url)) { checkConnection(); return; }
  if (changeInfo.status === "complete") { checkConnection(); }
});

// ─────────────────────────────────────────────
// Run queue
// ─────────────────────────────────────────────
// Tracks every URL downloaded in this session — never re-download the same image
const sessionDownloadedUrls = new Set();

async function startQueue(startIndex = 0) {
  const lines = parsePrompts();
  if (!lines.length) { setStatus(t("msgAddPrompt")); return; }

  // Clear session tracking on fresh start (not on continue)
  if (startIndex === 0) sessionDownloadedUrls.clear();

  let waitMinMs = Math.round(Number(waitMinEl.value) * 1000) || 0;
  let waitMaxMs = Math.round(Number(waitMaxEl.value) * 1000) || 0;
  if (waitMaxMs < waitMinMs) [waitMinMs, waitMaxMs] = [waitMaxMs, waitMinMs];

  // Lock in the Flow tab ID
  const flowTab = (await findFlowTab()) || (await getActiveTab());
  if (!flowTab?.id) { setStatus(t("msgNoTab")); return; }
  flowTabId = flowTab.id;

  // On fresh start reset all statuses; on continue keep existing
  if (startIndex === 0) {
    promptStatuses = lines.map(text => ({ text, status: "pending" }));
  } else {
    // Reset from resume point onwards to pending
    for (let j = startIndex; j < lines.length; j++) {
      if (promptStatuses[j]) promptStatuses[j].status = "pending";
    }
  }
  renderList();
  listSection.style.display = "";

  isRunning = true;
  runBtn.disabled = true;
  hideContinue();
  setInputsDisabled(true);
  appEl.classList.add("is-running");
  let completed = 0;
  setStatus(t("msgStarting", lines.length));

  for (let i = startIndex; i < lines.length; i++) {
    if (!isRunning) {
      for (let j = i; j < lines.length; j++) updateStatus(j, "stopped");
      showContinue(i); // offer to resume from this point
      break;
    }

    updateStatus(i, "generating");
    let promptDone = false;

    for (let attempt = 0; attempt <= 1; attempt++) {
      if (!isRunning) break;

      if (attempt === 1) {
        // Countdown before retry
        for (let s = 3; s > 0 && isRunning; s--) {
          setStatus(`Prompt ${i + 1} failed — retrying in ${s}s…`);
          await sleep(1000);
        }
        if (!isRunning) break;
        updateStatus(i, "generating");
        setStatus(`Prompt ${i + 1} — retrying…`);
      } else {
        setStatus(t("msgSubmitting", i + 1, lines.length));
      }

      const countRes        = await sendToFlowTab({ type: "FLOW_GET_TILE_COUNT" });
      const beforeCount     = countRes?.count     ?? 0;
      const beforeSrcs      = countRes?.srcs      ?? [];
      const beforeVideoSrcs = countRes?.videoSrcs ?? [];
      const beforeFailCount = countRes?.failCount  ?? 0;

      // When Character Consistency is ON, extract asset names from prompt
      const refAssetNames = charConsistencyToggle?.checked
        ? extractAssetNames(lines[i])
        : [];

      const submitRes = await sendToFlowTab({
        type: "FLOW_BATCH_RUN",
        prompts: [lines[i]],
        waitMinMs: 0, waitMaxMs: 0,
        charDelayMs: CHAR_DELAY_MS,
        refAssetNames,
      });

      if (!isRunning) break;

      if (!submitRes || submitRes.error) {
        if (attempt < 1) continue; // retry
        updateStatus(i, "failed");
        setStatus(t("msgError", i + 1, submitRes?.error || "no response"));
        for (let j = i + 1; j < lines.length; j++) updateStatus(j, "stopped");
        showContinue(i); // offer to retry from this failed prompt
        isRunning = false;
        break;
      }

      setStatus(t("msgWaiting", i + 1));
      const genRes = await sendToFlowTab({ type: "FLOW_WAIT_GENERATION", beforeCount, beforeSrcs, beforeVideoSrcs, beforeFailCount, timeoutMs: 300000 });

      if (!isRunning) break;

      if (genRes?.failed) {
        // Genuine failure card detected — retry by resubmitting
        if (attempt < 1) continue;
        updateStatus(i, "failed");
        setStatus(`Prompt ${i + 1} failed after retry — moving to next.`);
        promptDone = true;
        break;
      }

      if (genRes?.timeout) {
        // Timed out — image may have generated but wasn't detected
        // Do NOT resubmit — just mark failed and move on to avoid double generation
        updateStatus(i, "failed");
        setStatus(`Prompt ${i + 1} timed out — moving to next.`);
        promptDone = true;
        break;
      }

      // Success — filter out any URLs already downloaded this session
      const newUrls = (genRes?.newUrls || []).filter(url => !sessionDownloadedUrls.has(url));
      if (newUrls.length > 0) {
        setStatus(t("msgDownloading", i + 1));
        if (autoDownloadToggle.checked) {
          await downloadGeneratedImages(newUrls, i + 1, lines[i]);
        }
        newUrls.forEach(url => sessionDownloadedUrls.add(url));
      }

      updateStatus(i, "done");
      completed++;
      promptDone = true;
      break; // no retry needed
    }

    // promptDone = true means either success or skip-after-fail — both continue queue
    // promptDone = false only if isRunning was set to false (submit error path)

    if (i < lines.length - 1 && isRunning) {
      const pause = randomWait(waitMinMs, waitMaxMs);
      await countdown(Math.round(pause / 1000));
    }
  }

  isRunning = false;
  flowTabId = null;
  setInputsDisabled(false);
  appEl.classList.remove("is-running");

  const failedCount  = promptStatuses.filter(p => p.status === "failed").length;
  const stoppedCount = promptStatuses.filter(p => p.status === "stopped").length;

  if (stoppedCount > 0) {
    // Queue stopped for any reason with skipped prompts — offer to continue
    const firstStopped = promptStatuses.findIndex(p => p.status === "stopped");
    showContinue(firstStopped);
    runBtn.disabled = true;
    setStatus(`Stopped — ${completed} done, ${stoppedCount} skipped.`);
  } else {
    // Queue ran through all prompts — no Continue needed
    hideContinue();
    runBtn.disabled = false;
    if (failedCount > 0) {
      setStatus(`Done — ${completed} succeeded, ${failedCount} failed.`);
    } else {
      setStatus(t("msgAllDone", completed));
    }
  }
}

runBtn.addEventListener("click", () => startQueue(0));

// ─────────────────────────────────────────────
// Continue
// ─────────────────────────────────────────────
continueBtn.addEventListener("click", () => {
  if (resumeFromIdx !== null) startQueue(resumeFromIdx);
});

// ─────────────────────────────────────────────
// Stop
// ─────────────────────────────────────────────
stopBtn.addEventListener("click", async () => {
  isRunning = false;
  flowTabId = null;
  await sendToFlowTab({ type: "FLOW_BATCH_STOP" });
  setStatus(t("msgStopped"));
  setInputsDisabled(false);
  appEl.classList.remove("is-running");
  // runBtn stays disabled — Continue button is shown by the loop
});

// ─────────────────────────────────────────────
// Persist / restore
// ─────────────────────────────────────────────
// On launch — restore only settings (delay, folder, language)
// Prompts always start fresh every session
chrome.storage.local.get(
  ["flowBatchWaitMin", "flowBatchWaitMax", "zapLang", "zapSerial", "flowBatchFolder"],
  (r) => {
    if (r.flowBatchWaitMin != null) waitMinEl.value = String(r.flowBatchWaitMin);
    if (r.flowBatchWaitMax != null) waitMaxEl.value = String(r.flowBatchWaitMax);
    downloadFolderEl.value = r.flowBatchFolder || "autoflow-img"; // restore saved folder or default
    if (r.zapSerial != null)        serialToggleEl.checked     = r.zapSerial;
    if (r.zapAutoDownload != null)  autoDownloadToggle.checked = r.zapAutoDownload;
    if (r.zapLang) {
      currentLang = r.zapLang;
      langSelectEl.value = currentLang;
    }
    applyLanguage();
  }
);

// Persist only settings, never prompts
function persist() {
  chrome.storage.local.set({
    flowBatchWaitMin:  waitMinEl.value,
    flowBatchWaitMax:  waitMaxEl.value,
    flowBatchFolder:   downloadFolderEl.value,
    zapSerial:         serialToggleEl.checked,
    zapAutoDownload:   autoDownloadToggle.checked,
  });
}
waitMinEl.addEventListener("change", persist);
waitMaxEl.addEventListener("change", persist);
downloadFolderEl.addEventListener("change", persist);
serialToggleEl.addEventListener("change", persist);
autoDownloadToggle.addEventListener("change", persist);

// ─────────────────────────────────────────────
// Character Consistency
// ─────────────────────────────────────────────
const charConsistencyToggle = document.getElementById("charConsistencyToggle");

charConsistencyToggle?.addEventListener("change", () => {
  chrome.storage.local.set({ zapCharConsistency: charConsistencyToggle.checked });
  renderList();
});

// Restore toggle state on load
chrome.storage.local.get("zapCharConsistency", (r) => {
  if (charConsistencyToggle) charConsistencyToggle.checked = r.zapCharConsistency === true;
  renderList();
});

// Extract underscore_names from prompt text (e.g. amma_khadija, family_home)
function extractAssetNames(text) {
  const matches = text.match(/\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b/g);
  return matches ? [...new Set(matches)] : [];
}

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { invoke } from "@tauri-apps/api/core"
import { PhysicalSize } from "@tauri-apps/api/dpi"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import packageJson from "../package.json"
import { loadAccounts, saveAccounts } from "./services/account-store"

type ProviderId = "google" | "dola" | "migoo" | "chatgpt" | "minimax" | "leonardo" | "custom"
type Account = {
  id: string
  name: string
  email: string | null
  avatarUrl: string | null
  avatar: string
  favorite: boolean
  order: number
  provider: ProviderId
  customUrl?: string | null
  lastOpenedAt?: number | null
}
// Provider metadata: Google Flow, Dola, Migoo + ChatGPT, Hailuo (Minimax),
// Leonardo AI, dan situs custom milik user.
const PROVIDERS: Record<ProviderId, { name: string; short: string; url: string; avatar: string; openLabel: string; loadingLabel: string }> = {
  google: { name: "Google Flow", short: "Google", url: "https://flow.google.com/", avatar: "/google-flow.png", openLabel: "Open Google Flow", loadingLabel: "Loading Google Flow..." },
  dola: { name: "Dola", short: "Dola", url: "https://www.dola.com/chat/", avatar: "/dola.png", openLabel: "Open Dola", loadingLabel: "Loading Dola..." },
  migoo: { name: "Migoo", short: "Migoo", url: "https://migoo.ai/", avatar: "/migoo.png", openLabel: "Open Migoo", loadingLabel: "Loading Migoo..." },
  chatgpt: { name: "ChatGPT", short: "ChatGPT", url: "https://chatgpt.com/", avatar: "/chatgpt.svg", openLabel: "Open ChatGPT", loadingLabel: "Loading ChatGPT..." },
  minimax: { name: "Hailuo (Minimax)", short: "Minimax", url: "https://hailuoai.video/", avatar: "/minimax.png", openLabel: "Open Hailuo", loadingLabel: "Loading Hailuo..." },
  leonardo: { name: "Leonardo AI", short: "Leonardo", url: "https://app.leonardo.ai/", avatar: "/leonardo.png", openLabel: "Open Leonardo", loadingLabel: "Loading Leonardo..." },
  custom: { name: "Custom Site", short: "Custom", url: "", avatar: "/custom.svg", openLabel: "Open Site", loadingLabel: "Loading site..." },
}
const PROVIDER_IDS: ProviderId[] = ["google", "dola", "migoo", "chatgpt", "minimax", "leonardo", "custom"]
const normalizeProvider = (value: unknown): ProviderId =>
  (PROVIDER_IDS as string[]).includes(value as string) ? (value as ProviderId) : "google"
const providerMeta = (id: unknown) => PROVIDERS[normalizeProvider(id)]
const customHost = (url: unknown): string => {
  try {
    const raw = String(url || "").trim()
    if (!raw) return "Custom"
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`)
    return u.hostname.replace(/^www\./, "") || "Custom"
  } catch {
    return "Custom"
  }
}
const badgeFor = (a: Account) =>
  normalizeProvider(a.provider) === "custom" ? customHost(a.customUrl) : providerMeta(a.provider).short
const displayProviderName = (a: Account) =>
  normalizeProvider(a.provider) === "custom" ? customHost(a.customUrl) : providerMeta(a.provider).name
const avatarFor = (a: Account) =>
  a.avatarUrl ||
  (normalizeProvider(a.provider) === "custom" && a.customUrl
    ? `https://www.google.com/s2/favicons?domain=${customHost(a.customUrl)}&sz=64`
    : providerMeta(a.provider).avatar)
const LICENSE_PURCHASE_URL = "https://tokotelegram.com/toko/flowmanager"
const TELEGRAM_CHANNEL_URL = "https://t.me/flowmanager"
// Server URL diambil runtime via command get_license_server_url (satu sumber kebenaran).
type ServerPlan = { id: string; name: string; price: number; originalPrice: number; description: string; active: boolean; sort: number }
type ThemeMode = "system" | "light" | "dark"
const THEME_STORAGE_KEY = "flowmanager-theme"
const resolveTheme = (mode: ThemeMode): "light" | "dark" => {
  if (mode === "light" || mode === "dark") return mode
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark"
  return "light"
}
const APP_VERSION = packageJson.version
type LicenseState = { plan: string; status: string; expires_at: string | null; lifetime: boolean; last_validated_at: string; device_id: string }
const licensePlanLabel = (plan: string) => ({ five_minutes: "5 Minutes", one_day: "1 Day", seven_days: "7 Days", thirty_days: "30 Days", one_year: "1 Year", lifetime: "Lifetime" }[plan] || plan)
const licenseStatusLabel = (status: string) => status ? status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable"
const licenseExpiryLabel = (state: LicenseState | null) => state?.lifetime ? "Lifetime" : state?.expires_at ? new Date(state.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—"
// Harga plan dibaca dari server (/plans); fallback bila offline ada di LicensePage.
const starter: Account[] = [
  {
    id: "main",
    name: "Flow Main",
    email: null,
    avatarUrl: "/google-flow.png",
    avatar: "YK",
    favorite: true,
    order: 0,
    provider: "google",
  },
  {
    id: "dola-main",
    name: "Dola Main",
    email: null,
    avatarUrl: "/dola.png",
    avatar: "DM",
    favorite: false,
    order: 1,
    provider: "dola",
  },
  {
    id: "migo-main",
    name: "Migo Main",
    email: null,
    avatarUrl: "/migoo.png",
    avatar: "MM",
    favorite: false,
    order: 2,
    provider: "migoo",
  },
]

export default function App() {
  const [licensed, setLicensed] = useState(false)
  const [licenseChecking, setLicenseChecking] = useState(true)
  const [licenseError, setLicenseError] = useState("")
  const [licenseState, setLicenseState] = useState<LicenseState | null>(null)
  const [deviceId, setDeviceId] = useState("")
  const [key, setKey] = useState("")
  const [newKey, setNewKey] = useState("")
  const [activatingNew, setActivatingNew] = useState(false)
  const [activateNewError, setActivateNewError] = useState("")
  const [serverPlans, setServerPlans] = useState<ServerPlan[] | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [profile, setProfile] = useState<{
    name: string
    avatar: string | null
  }>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("flowmanager-profile") ||
          '{"name":"FlowManager","avatar":null}'
      )
    } catch {
      return { name: "FlowManager", avatar: null }
    }
  })
  const [query, setQuery] = useState("")
  const [view, setView] = useState<
    | "accounts"
    | "favorites"
    | "license"
    | "updates"
    | "info"
    | "settings"
    | "flow"
  >("accounts")
  const [active, setActive] = useState<Account | null>(null)
  const [fullView, setFullView] = useState(false)
  const [dialog, setDialog] = useState<Account | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newAccountName, setNewAccountName] = useState("")
  const [newAccountProvider, setNewAccountProvider] = useState<ProviderId>("google")
  const [newAccountUrl, setNewAccountUrl] = useState("")
  const [providerFilter, setProviderFilter] = useState<"all" | ProviderId>("all")
  const [addAccountError, setAddAccountError] = useState("")
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      return saved === "light" || saved === "dark" ? saved : "system"
    } catch {
      return "system"
    }
  })
  // Terapkan tema: system = mengikuti tema Windows (live via matchMedia).
  useEffect(() => {
    const apply = (mode: ThemeMode) => {
      const resolved = resolveTheme(mode)
      document.documentElement.dataset.theme = resolved
      try {
        const meta = document.querySelector('meta[name="theme-color"]')
        meta?.setAttribute("content", resolved === "dark" ? "#0a1120" : "#f4f7ff")
      } catch { /* abaikan */ }
      try {
        void getCurrentWindow().setTheme(resolved).catch(() => {})
      } catch { /* browser biasa: tidak ada jendela Tauri */ }
    }
    apply(themeMode)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch { /* abaikan */ }
    if (themeMode !== "system" || typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => apply("system")
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [themeMode])
  const [dragPoint, setDragPoint] = useState({ x: 0, y: 0 })
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [dragTargetId, setDragTargetId] = useState<string | null>(null)
  const [dragPreviewIds, setDragPreviewIds] = useState<string[] | null>(null)
  useEffect(() => { void (async () => { try {
    const id=await invoke<string>("get_device_id"); setDeviceId(id); const saved=await invoke<LicenseState|null>("get_license_state"); if(!saved?.status){setLicenseChecking(false);return} setLicenseState(saved); const validated=await invoke<LicenseState>("validate_license"); setLicenseState(validated); setLicensed(true); await invoke("expand_main_window"); const w=getCurrentWindow(); await w.show(); await w.setFocus() } catch (error) { setLicenseError(typeof error === "string" ? error : "Server Unavailable") } finally { setLicenseChecking(false) } })() }, [])
  const dragSourceRef = useRef<HTMLElement | null>(null)
  const dragPointerIdRef = useRef<number | null>(null)
  const dragSourceIdRef = useRef<string | null>(null)
  const dragTargetIdRef = useRef<string | null>(null)
  const dragInsertAfterRef = useRef(false)
  const handleRename = (a: Account) => {
    const n = prompt("Rename account", a.name)
    if (n)
      setAccounts(accounts.map((x) => (x.id === a.id ? { ...x, name: n } : x)))
    setMenu(null)
  }
  const handleDelete = (a: Account) => {
    setDialog(a)
    setMenu(null)
  }
  const confirmDelete = async () => {
    if (!dialog) return
    const removing = dialog
    try {
      const profileCleaned = await invoke<boolean>("remove_google_flow_account", {
        accountId: removing.id,
        provider: removing.provider,
      })
      setAccounts((current) => current.filter((account) => account.id !== removing.id))
      if (active?.id === removing.id) {
        setActive(null)
        setFullView(false)
        setView("accounts")
      }
      if (!profileCleaned) console.warn("Account removed; profile cleanup is pending")
      setDialog(null)
    } catch (error) {
      console.error("Unable to remove account", error)
    }
  }
  const handleToggleFavorite = (a: Account) => {
    setAccounts(
      accounts.map((x) => (x.id === a.id ? { ...x, favorite: !x.favorite } : x))
    )
    setMenu(null)
  }
  const handleAddAccount = () => {
    setNewAccountName("")
    setAddAccountError("")
    setNewAccountProvider("google")
    setNewAccountUrl("")
    setAddAccountOpen(true)
  }
  const createAccount = () => {
    const name = newAccountName.trim()
    if (!name) {
      setAddAccountError("Please enter an account name.")
      return
    }
    if (name.length > 80) {
      setAddAccountError("Account name must be 80 characters or fewer.")
      return
    }
    let customUrl: string | null = null
    if (newAccountProvider === "custom") {
      const raw = newAccountUrl.trim()
      if (!raw) {
        setAddAccountError("Please enter the site URL, e.g. app.example.com")
        return
      }
      try {
        const u = new URL(raw.includes("://") ? raw : `https://${raw}`)
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad scheme")
        if (!u.hostname || !u.hostname.includes(".")) throw new Error("bad host")
        customUrl = u.toString()
      } catch {
        setAddAccountError("That URL looks invalid. Use https://…")
        return
      }
    }
    const meta = providerMeta(newAccountProvider)
    const a: Account = {
      id: crypto.randomUUID(),
      name,
      email: null,
      avatarUrl: newAccountProvider === "custom" && customUrl
        ? `https://www.google.com/s2/favicons?domain=${customHost(customUrl)}&sz=64`
        : meta.avatar,
      avatar: "NF",
      favorite: false,
      order: accounts.length,
      provider: newAccountProvider,
      customUrl,
      lastOpenedAt: null,
    }
    setAccounts([...accounts, a])
    setAddAccountOpen(false)
  }
  const updateProfileAvatar = (avatar: string) => {
    const next = { ...profile, avatar }
    setProfile(next)
    localStorage.setItem("flowmanager-profile", JSON.stringify(next))
  }
  useEffect(() => {
    if (!licensed || accountsLoaded) return
    void loadAccounts().then((saved) => setAccounts(saved as Account[])).finally(() => setAccountsLoaded(true))
  }, [licensed, accountsLoaded])
  useEffect(() => {
    if (licensed && accountsLoaded) void saveAccounts(accounts)
  }, [accounts, licensed, accountsLoaded])
  useEffect(() => {
    const activeStillExists = active !== null && accounts.some((account) => account.id === active.id)
    if (view === "flow" && !activeStillExists) {
      setActive(null)
      setFullView(false)
      setView("accounts")
    } else if (view !== "flow" && fullView) {
      setFullView(false)
    }
  }, [active, accounts, view, fullView])
  const favoriteCount = accounts.filter((a) => a.favorite).length
  const providerCount = (id: ProviderId) => accounts.filter((a) => normalizeProvider(a.provider) === id).length
  const visible = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (view !== "favorites" || a.favorite) &&
          (providerFilter === "all" || normalizeProvider(a.provider) === providerFilter) &&
          `${a.name} ${a.email}`.toLowerCase().includes(query.toLowerCase())
      ),
    [accounts, query, view, providerFilter]
  )
  const displayed = useMemo(() => {
    if (!dragPreviewIds || view !== "accounts") return visible
    const byId = new Map(accounts.map((account) => [account.id, account]))
    return dragPreviewIds.map((id) => byId.get(id)).filter(Boolean) as Account[]
  }, [accounts, dragPreviewIds, view, visible])
  const finishPointerDrag = (commit: boolean) => {
    const sourceId = dragSourceIdRef.current
    const targetId = dragTargetIdRef.current
    if (commit && sourceId && targetId && sourceId !== targetId) {
      setAccounts((current) => {
        const sourceIndex = current.findIndex((a) => a.id === sourceId)
        const targetIndex = current.findIndex((a) => a.id === targetId)
        if (sourceIndex < 0 || targetIndex < 0) return current
        const next = [...current]
        const [source] = next.splice(sourceIndex, 1)
        const insertionIndex = next.findIndex((a) => a.id === targetId)
        next.splice(insertionIndex + (dragInsertAfterRef.current ? 1 : 0), 0, source)
        return next.map((a, index) => ({ ...a, order: index }))
      })
    }
    if (dragSourceRef.current && dragPointerIdRef.current !== null) {
      try { dragSourceRef.current.releasePointerCapture(dragPointerIdRef.current) } catch { /* already released */ }
    }
    dragSourceRef.current = null
    dragPointerIdRef.current = null
    dragSourceIdRef.current = null
    dragTargetIdRef.current = null
    setDraggingId(null)
    setDragTargetId(null)
    setDragPreviewIds(null)
  }
  useEffect(() => {
    const accountAtPoint = (x: number, y: number) => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-account-id]"))
        .filter((element) => element.dataset.accountId !== dragSourceIdRef.current)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      const hit = candidates.find(({ rect }) =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      )
      if (hit) return { id: hit.element.dataset.accountId || null, after: x > (hit.rect.left + hit.rect.right) / 2 }
      // Use the nearest card center when the pointer crosses a grid gap or a new row.
      const nearest = candidates
        .map(({ element, rect }) => ({
          element,
          rect,
          distance: Math.hypot((rect.left + rect.right) / 2 - x, (rect.top + rect.bottom) / 2 - y),
        }))
        .sort((a, b) => a.distance - b.distance)[0]
      if (!nearest) return null
      return { id: nearest.element.dataset.accountId || null, after: x > (nearest.rect.left + nearest.rect.right) / 2 }
    }
    const onMove = (event: PointerEvent) => {
      if (dragPointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      setDragPoint({ x: event.clientX, y: event.clientY })
      const hit = accountAtPoint(event.clientX, event.clientY)
      const targetId = hit?.id || null
      dragInsertAfterRef.current = hit?.after || false
      dragTargetIdRef.current = targetId
      setDragTargetId(targetId)
      if (targetId) setDragPreviewIds((current) => {
        const ids = current || accounts.map((a) => a.id)
        const from = ids.indexOf(dragSourceIdRef.current || "")
        const to = ids.indexOf(targetId)
        if (from < 0 || to < 0 || from === to) return ids
        const next = [...ids]
        const [moved] = next.splice(from, 1)
        const targetIndex = next.indexOf(targetId)
        next.splice(targetIndex + (dragInsertAfterRef.current ? 1 : 0), 0, moved)
        return next
      })
    }
    const onUp = (event: PointerEvent) => {
      if (dragPointerIdRef.current === event.pointerId) finishPointerDrag(true)
    }
    const onCancel = (event: PointerEvent) => {
      if (dragPointerIdRef.current === event.pointerId) finishPointerDrag(false)
    }
    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
    }
  }, [accounts])
  const beginPointerDrag = (id: string, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || view !== "accounts" || query.trim()) return
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return
    const rect = event.currentTarget.getBoundingClientRect()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragSourceRef.current = event.currentTarget
    dragPointerIdRef.current = event.pointerId
    dragSourceIdRef.current = id
    dragTargetIdRef.current = null
    dragInsertAfterRef.current = false
    setDraggingId(id)
    setDragTargetId(null)
    setDragPreviewIds(accounts.map((a) => a.id))
    setDragOffset({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    setDragPoint({ x: event.clientX, y: event.clientY })
  }
  const activateLicense = async () => {
    if (!key.trim() || !deviceId) { setLicenseError("Invalid License"); return }
    setLicenseChecking(true); setLicenseError("")
    try { const activated=await invoke<LicenseState>("activate_license", { licenseKey: key }); setLicenseState(activated); const w = getCurrentWindow(); setKey(""); setLicensed(true)
      await invoke("expand_main_window"); await w.show(); await w.setFocus(); return
    } catch (error) { setLicenseError(typeof error === "string" ? error : "Server Unavailable") } finally { setLicenseChecking(false) }
  }
  const activateNewKey = async () => {
    if (!newKey.trim()) { setActivateNewError("Enter your new key."); return }
    setActivatingNew(true); setActivateNewError("")
    try {
      const updated = await invoke<LicenseState>("activate_license", { licenseKey: newKey.trim() })
      setLicenseState(updated)
      setNewKey("")
    } catch (error) {
      setActivateNewError(typeof error === "string" ? error : "Server Unavailable")
    } finally {
      setActivatingNew(false)
    }
  }
  const fetchPlans = async () => {
    try {
      const base = await invoke<string>("get_license_server_url")
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const r = await fetch(`${base.replace(/\/$/, "")}/plans`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!r.ok) throw new Error("bad status")
      const data = await r.json()
      if (Array.isArray(data.plans)) setServerPlans(data.plans as ServerPlan[])
    } catch {
      setServerPlans(null) // fallback bawaan
    }
  }
  // Re-validasi berkala 15 menit: kunci bila expired di tengah sesi.
  useEffect(() => {
    if (!licensed) return
    const t = setInterval(() => {
      void invoke<LicenseState>("validate_license")
        .then((v) => setLicenseState(v))
        .catch((error) => {
          if (typeof error === "string" && /expired|revoked|mismatch|invalid/i.test(error)) {
            setLicenseError(error)
            setLicensed(false)
          }
        })
    }, 15 * 60 * 1000)
    return () => clearInterval(t)
  }, [licensed])
  useEffect(() => {
    if (licensed && !serverPlans) void fetchPlans()
  }, [licensed, serverPlans])
  const openLicensePurchase = () =>
    invoke("open_external_url", { url: LICENSE_PURCHASE_URL })
  if (licenseChecking && !licensed)
    return <div className="gate"><div className="gate-card"><Brand /><h1>Checking your license</h1><p>Connecting securely to FlowManager License Server…</p></div></div>
  if (!licensed) {
    const savedExpired = !!licenseState?.status && !licenseState.lifetime && !!licenseState.expires_at &&
      new Date(licenseState.expires_at).getTime() < Date.now()
    const exitApp = () => { void getCurrentWindow().close().catch(() => {}) }
    return (
      <div className="gate">
        <div className="gate-card">
          <Brand />
          {savedExpired ? (
            <>
              <h1>License Expired</h1>
              <p>Your license expired on {licenseExpiryLabel(licenseState)}. Buy a new key below — remaining time (if any) on this device carries over automatically. Old keys cannot be reused.</p>
            </>
          ) : (
            <>
              <h1>Enter your license</h1>
              <p>Activate FlowManager with your license key.</p>
            </>
          )}
          <input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Enter your license key"
            onKeyDown={(e) => e.key === "Enter" && activateLicense()}
          />
          <button className="primary wide" onClick={activateLicense}>
            {licenseChecking ? "Activating…" : "Activate FlowManager →"}
          </button>
          {licenseError && <p className="dialog-error">{licenseError}</p>}
          <div className="link">
            {savedExpired ? "Need more time? " : "Don’t have a license? "}
            <a
              href={LICENSE_PURCHASE_URL}
              onClick={(e) => {
                e.preventDefault()
                void openLicensePurchase()
              }}
            >
              <u>Buy a license →</u>
            </a>
          </div>
          {savedExpired && (
            <button className="secondary wide" onClick={exitApp}>
              Keluar
            </button>
          )}
          <small>
            🔒 Your provider login is handled directly inside the provider site.
            <br />
            We never store your login details.
          </small>
        </div>
      </div>
    )
  }
  if (view === "flow" && active)
    return (
      <div className={`app ${fullView ? "full" : ""}`}>
        {!fullView && (
          <Sidebar
            view="flow"
            setView={setView}
            profile={profile}
            licenseState={licenseState}
            accounts={accounts}
            activeAccountId={active.id}
            onSelectAccount={(account) => {
              if (account.id !== active.id) {
                // Catat waktu buka: akun naik ke puncak kategorinya di switcher.
                const now = Date.now()
                setAccounts((current) =>
                  current.map((x) => (x.id === account.id ? { ...x, lastOpenedAt: now } : x))
                )
                setActive({ ...account, lastOpenedAt: now })
              }
            }}
          />
        )}
        <main className="content flow-content">
          <FlowShell
            account={active}
            fullView={fullView}
            onToggleFullView={() => {
              setFullView((current) => !current)
            }}
            onBack={() => {
              if (active) void invoke("close_google_flow", { accountId: active.id, provider: active.provider })
              else void invoke("close_google_flow")
              setFullView(false)
              setView("accounts")
            }}
          />
        </main>
      </div>
    )
  return (
    <div className="app">
      <Sidebar view={view} setView={setView} profile={profile} licenseState={licenseState} />
      <main className="content">
        {(() => {
          if (licenseState?.lifetime || !licenseState?.expires_at) return null
          const ms = new Date(licenseState.expires_at).getTime() - Date.now()
          if (isNaN(ms) || ms <= 0 || ms > 7 * 86400000) return null
          const days = Math.max(1, Math.ceil(ms / 86400000))
          return (
            <div className="expiry-banner" role="status">
              <span>⏳ License expires in {days} day{days === 1 ? "" : "s"} ({licenseExpiryLabel(licenseState)}). Buy a new key before it ends — remaining time carries over on this device.</span>
              <button className="secondary sm" onClick={() => setView("license")}>Buy Key</button>
            </div>
          )
        })()}
        <header>
          <div>
            <div className="eyebrow">
              FLOWMANAGER /{" "}
              {view === "settings"
                ? "SETTINGS"
                : view === "favorites"
                ? "FAVORITES"
                : view.toUpperCase()}
            </div>
            <h1>
              {view === "settings"
                ? "Settings"
                : view === "favorites"
                ? "Favorite Accounts"
                : view === "license"
                ? "License"
                : view === "updates"
                ? "Updates"
                : view === "info"
                ? "How to Use FlowManager"
                : "AI Accounts"}
            </h1>
            <p>
              {view === "settings"
                ? "Keep FlowManager personal, private, and ready to use."
                : view === "favorites"
                ? "Your favorite AI accounts in one place."
                : view === "license"
                ? "Choose the FlowManager license that fits your needs."
                : view === "updates"
                ? "Keep FlowManager up to date with the latest version."
                : view === "info"
                ? "A quick guide to managing all your AI accounts."
                : "Manage all your AI accounts in one place."}
            </p>
            {view === "accounts" && (
              <div className="account-count">
                {accounts.length}{" "}
                {accounts.length === 1 ? "Account" : "Accounts"}
                {"  ·  "}{providerCount("google")} Google  ·  {providerCount("dola")} Dola  ·  {providerCount("migoo")} Migoo  ·  {providerCount("chatgpt")} ChatGPT  ·  {providerCount("minimax")} Minimax  ·  {providerCount("leonardo")} Leonardo  ·  {providerCount("custom")} Custom
              </div>
            )}
            {(view === "accounts" || view === "favorites") && (
              <div className="filter-chips" role="tablist" aria-label="Filter by provider">
                <button
                  className={providerFilter === "all" ? "chip active" : "chip"}
                  onClick={() => setProviderFilter("all")}
                >
                  All
                </button>
                {PROVIDER_IDS.map((id) => (
                  <button
                    key={id}
                    className={providerFilter === id ? "chip active" : "chip"}
                    onClick={() => setProviderFilter(providerFilter === id ? "all" : id)}
                  >
                    <img src={PROVIDERS[id].avatar} alt="" />
                    {PROVIDERS[id].short}
                  </button>
                ))}
              </div>
            )}
            {view === "favorites" && (
              <div className="account-count">{favoriteCount} Favorites</div>
            )}
          </div>
          {view === "accounts" && (
            <div className="header-actions">
              <div className="search">
                ⌕
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search accounts..."
                />
              </div>
              <button className="primary" onClick={handleAddAccount}>
                ＋ Add Account
              </button>
            </div>
          )}
        </header>
        {view === "settings" ? (
          <Settings profile={profile} onAvatarChange={updateProfileAvatar} themeMode={themeMode} onThemeChange={setThemeMode} deviceId={deviceId} />
        ) : view === "license" ? (
          <LicensePage
            licenseState={licenseState}
            plans={serverPlans}
            onBuy={() => void openLicensePurchase()}
            newKey={newKey}
            setNewKey={(v) => { setNewKey(v); setActivateNewError("") }}
            activating={activatingNew}
            activateError={activateNewError}
            onActivateNew={() => void activateNewKey()}
          />
        ) : view === "updates" ? (
          <UpdatesPage />
        ) : view === "info" ? (
          <InfoPage />
        ) : (
          <>
            <div className="grid">
              {displayed.map((a) => (
                <Card
                  key={a.id}
                  a={a}
                  menuOpen={menu === a.id}
                  onMenu={() => setMenu(menu === a.id ? null : a.id)}
                  onOpen={() => {
                    const now = Date.now()
                    setAccounts((current) =>
                      current.map((x) => (x.id === a.id ? { ...x, lastOpenedAt: now } : x))
                    )
                    setActive({ ...a, lastOpenedAt: now })
                    setView("flow")
                  }}
                  onFavorite={() => handleToggleFavorite(a)}
                  onDelete={() => handleDelete(a)}
                  onRename={() => handleRename(a)}
                  dragEnabled={view === "accounts" && !query.trim()}
                  isDragging={draggingId === a.id}
                  isDropTarget={dragTargetId === a.id}
                  onPointerDown={(event) => beginPointerDrag(a.id, event)}
                />
              ))}
              {view === "accounts" && (
                <AddAccountCard onAdd={handleAddAccount} />
              )}
            </div>
            {draggingId && <DragPreview account={accounts.find((a) => a.id === draggingId) || null} point={dragPoint} offset={dragOffset} />}
          </>
        )}
        {dialog && (
          <div className="overlay">
            <div className="dialog">
              <h2>Delete {dialog.name}?</h2>
              <p>
                This removes the account card from FlowManager. Your{" "}
                {normalizeProvider(dialog.provider) === "custom"
                  ? `${customHost(dialog.customUrl)} `
                  : `${providerMeta(dialog.provider).name} `}
                account is not affected.
              </p>
              <div className="dialog-actions">
                <button className="secondary" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => void confirmDelete()}
                >
                  Delete account
                </button>
              </div>
            </div>
          </div>
        )}
        {addAccountOpen && (
          <div className="overlay">
            <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-account-title">
              <h2 id="add-account-title">Add Account</h2>
              <p>Choose a provider, then enter a name for this account.</p>
              <div className="provider-picker" role="radiogroup" aria-label="Account provider">
                {PROVIDER_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={newAccountProvider === id}
                    className={newAccountProvider === id ? "provider-option selected" : "provider-option"}
                    onClick={() => setNewAccountProvider(id)}
                  >
                    <img src={PROVIDERS[id].avatar} alt="" />
                    <b>{PROVIDERS[id].name}</b>
                    <small>{PROVIDERS[id].url ? PROVIDERS[id].url.replace("https://", "").replace(/\/$/, "") : "your own https URL"}</small>
                  </button>
                ))}
              </div>
              {newAccountProvider === "custom" && (
                <input
                  value={newAccountUrl}
                  onChange={(event) => {
                    setNewAccountUrl(event.target.value)
                    setAddAccountError("")
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") createAccount()
                  }}
                  placeholder="Site URL, e.g. app.example.com"
                  inputMode="url"
                  aria-label="Custom site URL"
                />
              )}
              <input
                autoFocus
                value={newAccountName}
                onChange={(event) => {
                  setNewAccountName(event.target.value)
                  setAddAccountError("")
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createAccount()
                }}
                placeholder="Enter account name"
                maxLength={80}
              />
              {addAccountError && <p className="dialog-error">{addAccountError}</p>}
              <div className="dialog-actions">
                <button className="secondary" onClick={() => setAddAccountOpen(false)}>
                  Cancel
                </button>
                <button className="primary" onClick={createAccount}>
                  Add Account
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
function Brand() {
  return (
    <div className="brand">
      <img className="brand-image" src="/logo.png" alt="FlowManager logo" />
      <span>FLOWMANAGER</span>
    </div>
  )
}
function Sidebar({
  view,
  setView,
  profile,
  licenseState,
  accounts,
  activeAccountId,
  onSelectAccount,
}: {
  view: string
  setView: (v: any) => void
  profile: { name: string; avatar: string | null }
  licenseState: LicenseState | null
  accounts?: Account[]
  activeAccountId?: string | null
  onSelectAccount?: (a: Account) => void
}) {
  const inFlow = view === "flow" && accounts && onSelectAccount
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("flowmanager-sidecats") || "{}")
    } catch {
      return {}
    }
  })
  const toggleCat = (id: ProviderId) => {
    setCollapsedCats((current) => {
      const next = { ...current, [id]: !current[id] }
      try {
        localStorage.setItem("flowmanager-sidecats", JSON.stringify(next))
      } catch { /* abaikan */ }
      return next
    })
  }
  // Kategori urutan tetap (PROVIDER_IDS); hanya yang berisi akun yang tampil.
  // Dalam kategori: terakhir dibuka paling atas.
  const grouped = inFlow
    ? PROVIDER_IDS.map((pid) => ({
        pid,
        items: (accounts as Account[])
          .filter((a) => normalizeProvider(a.provider) === pid)
          .sort((x, y) => (y.lastOpenedAt || 0) - (x.lastOpenedAt || 0) || x.order - y.order),
      })).filter((g) => g.items.length > 0)
    : []
  return (
    <aside>
      <Brand />
      {inFlow ? (
        <>
          <div className="side-label">ACCOUNTS</div>
          <div className="side-accounts" role="listbox" aria-label="Switch account">
            {grouped.map((g) => {
              const meta = PROVIDERS[g.pid]
              const collapsed = !!collapsedCats[g.pid]
              return (
                <div key={g.pid} className="side-cat">
                  <button
                    className="side-cat-header"
                    onClick={() => toggleCat(g.pid)}
                    aria-expanded={!collapsed}
                    title={collapsed ? `Tampilkan ${meta.name}` : `Sembunyikan ${meta.name}`}
                  >
                    <img src={meta.avatar} alt="" />
                    <span className="side-cat-name">{meta.short}</span>
                    <span className="side-cat-count">{g.items.length}</span>
                    <span className={`side-cat-chevron${collapsed ? " closed" : ""}`}>▾</span>
                  </button>
                  {!collapsed &&
                    g.items.map((a) => (
                      <button
                        key={a.id}
                        role="option"
                        aria-selected={a.id === activeAccountId}
                        className={a.id === activeAccountId ? "side-account nested selected" : "side-account nested"}
                        onClick={() => (onSelectAccount as (a: Account) => void)(a)}
                        title={`Open ${a.name} (${badgeFor(a)})`}
                      >
                        <img src={avatarFor(a)} alt="" />
                        <span className="side-account-name">{a.name}</span>
                        {a.favorite && <span className="side-account-fav">★</span>}
                      </button>
                    ))}
                </div>
              )
            })}
          </div>
          <div className="rule" />
        </>
      ) : null}
      <div className="side-label">WORKSPACE</div>
      <button
        className={view === "accounts" ? "active" : ""}
        onClick={() => setView("accounts")}
      >
        <SidebarIcon name="accounts" /> <span>Accounts</span>
      </button>
      <button
        className={view === "favorites" ? "active" : ""}
        onClick={() => setView("favorites")}
      >
        <SidebarIcon name="favorites" /> <span>Favorites</span>
      </button>
      <div className="rule" />
      <div className="side-label">GENERAL</div>
      <button
        className={view === "license" ? "active" : ""}
        onClick={() => setView("license")}
      >
        <SidebarIcon name="license" /> <span>License</span>
      </button>
      <button
        className={view === "updates" ? "active" : ""}
        onClick={() => setView("updates")}
      >
        <SidebarIcon name="updates" /> <span>Updates</span>
      </button>
      <button
        className={view === "info" ? "active" : ""}
        onClick={() => setView("info")}
      >
        <SidebarIcon name="info" /> <span>Info</span>
      </button>
      <button
        className={view === "settings" ? "active" : ""}
        onClick={() => setView("settings")}
      >
        <SidebarIcon name="settings" /> <span>Settings</span>
      </button>
      <div className="side-bottom">
        <div className="avatar">
          {profile.avatar ? (
            <img src={profile.avatar} alt="FlowManager profile" />
          ) : (
            "YK"
          )}
        </div>
        <div>
          <div className="side-license-info">
            <small>
              <span>License {licenseState ? licenseStatusLabel(licenseState.status) : "Unavailable"}: <b>{licenseState ? licensePlanLabel(licenseState.plan) : "—"}</b></span>
              <span>Expired: <b>{licenseExpiryLabel(licenseState)}</b></span>
            </small>
          </div>
        </div>
      </div>
    </aside>
  )
}
function SidebarIcon({ name }: { name: "accounts" | "favorites" | "license" | "updates" | "info" | "settings" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true }
  const paths = {
    accounts: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    favorites: <path d="m12 4 2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-4 5.6-.8L12 4Z" />,
    license: <><path d="M7 4h10l2 3v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7l2-3Z" /><path d="M9 4v4h6V4M9 13h6M9 17h4" /></>,
    updates: <><path d="M20 11a8 8 0 0 0-14.7-4L4 9" /><path d="M4 4v5h5M4 13a8 8 0 0 0 14.7 4L20 15" /><path d="M20 20v-5h-5" /></>,
    info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="1.8" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.8" fill="currentColor" stroke="none" /><circle cx="10" cy="18" r="1.8" fill="currentColor" stroke="none" /></>,
  }
  return <svg className="sidebar-icon" {...common}>{paths[name]}</svg>
}
function LicensePage({ licenseState, plans, onBuy, newKey, setNewKey, activating, activateError, onActivateNew }: {
  licenseState: LicenseState | null
  plans: ServerPlan[] | null
  onBuy: () => void
  newKey: string
  setNewKey: (v: string) => void
  activating: boolean
  activateError: string
  onActivateNew: () => void
}) {
  const idr = (n: number) => "Rp" + Number(n || 0).toLocaleString("id-ID")
  const visible = (plans || []).filter((p) => p.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0))
  const fallback = visible.length === 0
  const items = fallback
    ? [
        { id: "thirty_days", name: "30 Days", price: 25000, originalPrice: 50000, description: "FlowManager access for 30 days" },
        { id: "one_year", name: "1 Year", price: 99000, originalPrice: 149000, description: "FlowManager access for 1 year" },
        { id: "lifetime", name: "Lifetime", price: 149000, originalPrice: 249000, description: "FlowManager access with no expiration" },
      ]
    : visible
  const canTopup = !!licenseState?.status && !licenseState.lifetime
  return (
    <div className="feature-page">
      <div className="plan-grid">
        {items.map((plan) => (
          <section className="plan-card" key={plan.id || plan.name}>
            <div className="eyebrow">{plan.name.toUpperCase()}</div>
            {plan.originalPrice > plan.price && <s>{idr(plan.originalPrice)}</s>}
            <strong>{idr(plan.price)}</strong>
            <p>{plan.description}.</p>
            <button className="primary" onClick={onBuy}>
              Buy License
            </button>
          </section>
        ))}
      </div>
      {canTopup && (
        <section className="license-info topup-section">
          <div className="eyebrow">RENEWAL</div>
          <h2>Activate a new key</h2>
          <p>Bought a new key? Activate it here — any remaining time carries over automatically, then the old key is retired permanently. Each key is single-use.</p>
          <div className="topup-row">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Enter your new key"
              onKeyDown={(e) => { if (e.key === "Enter") onActivateNew() }}
            />
            <button className="primary" onClick={onActivateNew} disabled={activating}>
              {activating ? "Activating…" : "Activate"}
            </button>
          </div>
          {activateError && <p className="dialog-error">{activateError}</p>}
          <p style={{ marginTop: 12 }}>
            <button className="secondary" onClick={onBuy}>
              Buy New Key
            </button>
          </p>
        </section>
      )}
      <section className="license-info">
        <div className="eyebrow">CURRENT LICENSE</div>
        <h2>Current License</h2>
        <div className="license-stats">
          <span>
            <b>Plan</b>
            {licenseState ? licensePlanLabel(licenseState.plan) : "—"}
          </span>
          <span>
            <b>Status</b>
            {licenseState ? licenseStatusLabel(licenseState.status) : "Unavailable"}
          </span>
          <span>
            <b>Expires</b>
            {licenseExpiryLabel(licenseState)}
          </span>
        </div>
      </section>
    </div>
  )
}
function UpdatesPage() {
  type UpdatePhase = "checking" | "upToDate" | "available" | "downloading" | "installing" | "relaunching" | "error"
  const [phase, setPhase] = useState<UpdatePhase>("checking")
  const [currentVersion, setCurrentVersion] = useState("—")
  const [latestVersion, setLatestVersion] = useState("—")
  const [releaseNotes, setReleaseNotes] = useState<string[]>([])
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [downloaded, setDownloaded] = useState(0)
  const [contentLength, setContentLength] = useState<number | null>(null)
  const checking = useRef(false)

  const checkForUpdates = async () => {
    if (checking.current) return
    checking.current = true
    setPhase("checking")
    try {
      const installedVersion = await getVersion()
      setCurrentVersion(installedVersion)
      const update = await check()
      setAvailableUpdate(update)
      if (!update) {
        setLatestVersion(installedVersion)
        setReleaseNotes([])
        setPhase("upToDate")
        return
      }
      setLatestVersion(update.version)
      setReleaseNotes(update.body ? update.body.split(/\r?\n/).filter(Boolean) : [])
      setPhase("available")
    } catch {
      setAvailableUpdate(null)
      setPhase("error")
    } finally {
      checking.current = false
    }
  }

  useEffect(() => {
    void checkForUpdates()
  }, [])

  const installUpdate = async () => {
    if (!availableUpdate) return
    setDownloaded(0)
    setContentLength(null)
    setPhase("downloading")
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setContentLength(event.data.contentLength ?? null)
          setDownloaded(0)
        } else if (event.event === "Progress") {
          setDownloaded((value) => value + event.data.chunkLength)
        } else if (event.event === "Finished") {
          setPhase("installing")
        }
      })
      setPhase("relaunching")
      await relaunch()
    } catch {
      setPhase("error")
    }
  }

  const status: Record<UpdatePhase, string> = {
    checking: "Checking for updates",
    upToDate: "Up to date",
    available: "Update available",
    downloading: "Downloading",
    installing: "Installing",
    relaunching: "Relaunching",
    error: "Update unavailable",
  }
  const progress = contentLength ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null
  const busy = phase === "checking" || phase === "downloading" || phase === "installing" || phase === "relaunching"

  return (
    <div className="feature-page">
      <section className="info-card update-card">
        <div className="update-versions">
          <div>
            <div className="eyebrow">CURRENT VERSION</div>
            <h2>{currentVersion}</h2>
          </div>
          <div>
            <div className="eyebrow">LATEST VERSION</div>
            <h2>{latestVersion}</h2>
          </div>
          <span className="badge">{status[phase]}</span>
        </div>
        <div className="update-actions">
          <button className="primary" disabled={busy || phase === "upToDate" || !availableUpdate} onClick={() => void installUpdate()}>
            {phase === "downloading" ? "Downloading…" : phase === "installing" ? "Installing…" : phase === "relaunching" ? "Relaunching…" : "Update Now"}
          </button>
          {phase === "error" && <button className="secondary" onClick={() => void checkForUpdates()}>Retry</button>}
        </div>
        {phase === "downloading" && <div className="update-progress" role="status">{progress === null ? `${Math.round(downloaded / 1024)} KB downloaded` : `${progress}% downloaded`}</div>}
      </section>
      <section className="info-card release-notes">
        <div className="eyebrow">WHAT'S NEW</div>
        {releaseNotes.length === 0 && <p>{phase === "upToDate" ? "You are using the latest version." : "Release notes are not available."}</p>}
        {releaseNotes.map((note) => (
          <p key={note}>• {note}</p>
        ))}
      </section>
    </div>
  )
}
function InfoPage() {
  const steps = [
    [
      "Enter Your License",
      "Enter your FlowManager license on the initial screen to activate the application.",
    ],
    [
      "Pick a Provider",
      "Click + Add Account, pick Google Flow, Dola, Migoo, ChatGPT, Hailuo, Leonardo, or a custom site, then name the account.",
    ],
    [
      "Sign In to the Provider",
      "Sign in directly inside the provider site. FlowManager never asks for or stores your provider password.",
    ],
    [
      "Manage Your Accounts",
      "Use Account Cards to open, rename, favorite, remove, and reorder accounts. Use the All / Google / Dola / Migoo chips to filter.",
    ],
    [
      "Open an Account",
      "Click Open Google Flow, Open Dola, or Open Migoo to open the selected account. Each provider keeps its own separate login session.",
    ],
    [
      "Switch Between Accounts",
      "Use the mini navigation while a provider is open to quickly switch between your accounts.",
    ],
  ]
  return (
    <div className="feature-page info-page">
      <div className="info-steps">
        {steps.map((step, i) => (
          <section className="info-step" key={step[0]}>
            <div className="step-number">{String(i + 1).padStart(2, "0")}</div>
            <div>
              <h2>{step[0]}</h2>
              <p>{step[1]}</p>
            </div>
          </section>
        ))}
      </div>
      <section className="privacy-info info-card">
        <div className="privacy-heading">
          <div className="eyebrow">PRIVACY &amp; SECURITY</div>
          <h2>Your accounts stay under your control.</h2>
          <span className="badge">LOCAL ACCOUNT DATA</span>
        </div>
        <div className="privacy-row">
          <span>🔒</span>
          <div>
            <h3>Provider Login Stays in the Provider</h3>
            <p>
              Your Google, Dola, or Migoo login is handled directly inside the
              provider page. FlowManager does not ask you to enter your
              provider password into FlowManager.
            </p>
          </div>
        </div>
        <div className="privacy-row">
          <span>🔑</span>
          <div>
            <h3>No Password Storage</h3>
            <p>
              FlowManager does not store your provider passwords or ask you to
              provide them to the application.
            </p>
          </div>
        </div>
        <div className="privacy-row">
          <span>💻</span>
          <div>
            <h3>Local Account Management</h3>
            <p>
              FlowManager stores account-management metadata locally on your
              device so you can organize all your AI accounts. Each provider
              keeps a separate login session.
            </p>
          </div>
        </div>
        <div className="privacy-row">
          <span>🛡️</span>
          <div>
            <h3>No Unnecessary Account Data Collection</h3>
            <p>
              FlowManager is designed to manage account shortcuts without
              requiring unnecessary account information. Your accounts remain
              managed through their providers.
            </p>
          </div>
        </div>
      </section>
      <section className="info-card telegram-card">
        <h2>Need help or want the latest updates?</h2>
        <p>
          Follow the FlowManager Telegram channel for announcements, guides, and
          product updates.
        </p>
        <button className="secondary" disabled={!TELEGRAM_CHANNEL_URL}>
          Join Telegram Channel
        </button>
      </section>
    </div>
  )
}

function AddAccountCard({ onAdd }: { onAdd: () => void }) {
  return (
    <button className="add-card" onClick={onAdd}>
      <span>＋</span>
      <b>Add Account</b>
      <small>Add a Google Flow, Dola, Migoo, ChatGPT, Hailuo, Leonardo, or custom account</small>
    </button>
  )
}

function Card({
  a,
  menuOpen,
  onMenu,
  onOpen,
  onFavorite,
  onDelete,
  onRename,
  dragEnabled,
  isDragging,
  isDropTarget,
  onPointerDown,
}: {
  a: Account
  menuOpen: boolean
  onMenu: () => void
  onOpen: () => void
  onFavorite: () => void
  onDelete: () => void
  onRename: () => void
  dragEnabled: boolean
  isDragging: boolean
  isDropTarget: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}) {
  return (
    <article data-account-id={a.id} onPointerDown={onPointerDown} className={`card ${dragEnabled ? "is-draggable" : ""} ${isDragging ? "is-dragging" : ""} ${isDropTarget ? "is-drop-target" : ""}`}>
      <div className="card-top">
        <button
          className={`star ${a.favorite ? "fav" : ""}`}
          onClick={onFavorite}
        >
          {a.favorite ? "★" : "☆"}
        </button>
        <div className="menu-wrap">
          <button className="more" onClick={onMenu}>
            •••
          </button>
          {menuOpen && (
            <div className="account-menu">
              <button onClick={onRename}>Rename</button>
              <button onClick={onFavorite}>
                {a.favorite ? "Remove from Favorites" : "Add to Favorites"}
              </button>
              <div className="menu-rule" />
              <button className="menu-danger" onClick={onDelete}>
                Delete Account
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="avatar large">
        <img
          src={avatarFor(a)}
          alt={`${normalizeProvider(a.provider) === "custom" ? customHost(a.customUrl) : providerMeta(a.provider).name} account`}
          draggable={false}
          onError={(e) => {
            const img = e.currentTarget
            if (!img.src.endsWith("/custom.svg")) img.src = "/custom.svg"
          }}
        />
      </div>
      <h2>{a.name}</h2>
      <span className={`provider-badge provider-${normalizeProvider(a.provider)}`}>{badgeFor(a)}</span>
      <button className="primary wide" onClick={onOpen}>
        {providerMeta(a.provider).openLabel} <span>→</span>
      </button>
      <div className="card-links">
        <button onClick={onRename}>✎ Rename</button>
        <button onClick={onDelete}>⌫ Remove</button>
      </div>
    </article>
  )
}
function DragPreview({ account, point, offset }: { account: Account | null; point: { x: number; y: number }; offset: { x: number; y: number } }) {
  if (!account) return null
  return (
    <div className="custom-drag-layer" aria-hidden="true">
      <article className="drag-preview-card" style={{ transform: `translate3d(${point.x - offset.x}px, ${point.y - offset.y}px, 0) scale(1.04) rotate(2deg)` }}>
        <div className="card-top"><span className={`star ${account.favorite ? "fav" : ""}`}>{account.favorite ? "★" : "☆"}</span><span className="more">•••</span></div>
        <div className="avatar large"><img src={avatarFor(account)} alt="" /></div>
        <h2>{account.name}</h2>
        <div className="primary wide">{providerMeta(account.provider).openLabel} <span>→</span></div>
      </article>
    </div>
  )
}
function Settings({
  profile,
  onAvatarChange,
  themeMode,
  onThemeChange,
  deviceId,
}: {
  profile: { name: string; avatar: string | null }
  onAvatarChange: (avatar: string) => void
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  deviceId: string
}) {
  const themeOptions: { id: ThemeMode; label: string; hint: string }[] = [
    { id: "system", label: "System", hint: "Follow Windows" },
    { id: "light", label: "Light", hint: "Always light" },
    { id: "dark", label: "Dark", hint: "Always dark" },
  ]
  return (
    <div className="settings">
      <section className="profile-section">
        <label className="setting-icon profile-avatar-input" title="Change profile photo">
          {profile.avatar ? (
            <img src={profile.avatar} alt="FlowManager profile" />
          ) : (
            (profile.name || "FM").trim().slice(0, 2).toUpperCase()
          )}
          <input
            id="profile-avatar-input"
            type="file"
            accept="image/*"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const reader = new FileReader()
              reader.onload = () =>
                typeof reader.result === "string" &&
                onAvatarChange(reader.result)
              reader.readAsDataURL(file)
              e.target.value = ""
            }}
          />
          <span className="profile-avatar-edit" aria-hidden="true">
            ✎
          </span>
        </label>
        <div>
          <div className="eyebrow">PROFILE</div>
          <h2>{profile.name || "Your FlowManager profile"}</h2>
          <p>Local desktop profile used for your account manager. Click the photo to change it.</p>
        </div>
      </section>
      <section>
        <div>
          <div className="eyebrow">APPEARANCE</div>
          <h2>Theme</h2>
          <p>
            System follows your Windows theme automatically. Pick Light or Dark to override it.
          </p>
          <div className="theme-segment" role="radiogroup" aria-label="App theme">
            {themeOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={themeMode === opt.id}
                className={themeMode === opt.id ? "theme-option selected" : "theme-option"}
                onClick={() => onThemeChange(opt.id)}
              >
                <b>{opt.label}</b>
                <small>{opt.hint}</small>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section>
        <div>
          <div className="eyebrow">PRIVACY & SECURITY</div>
          <h2>Your data stays local</h2>
          <p>
            FlowManager stores account metadata on this device. Provider passwords
            and credentials are never captured.
          </p>
        </div>
        <span className="badge">LOCAL ONLY</span>
      </section>
      <section>
        <div>
          <div className="eyebrow">DEVICE</div>
          <h2>This device</h2>
          <p>
            License is bound to this device. Send this ID to admin if you change laptop.
          </p>
          <div className="topup-row">
            <input readOnly value={deviceId} aria-label="Device ID" onFocus={(e) => e.target.select()} />
            <button
              className="secondary"
              onClick={() => { try { void navigator.clipboard.writeText(deviceId) } catch {} }}
            >
              Copy ID
            </button>
          </div>
        </div>
      </section>
      <section>
        <div>
          <div className="eyebrow">ABOUT</div>
          <h2>
            FlowManager <span className="muted">{APP_VERSION}</span>
          </h2>
          <p>Multi-AI desktop workspace and multi-account manager.</p>
          <p className="muted">Build: {typeof __FM_BUILD_ID__ !== "undefined" ? __FM_BUILD_ID__ : "dev"}</p>
        </div>
      </section>
    </div>
  )
}
function FlowShell({
  account,
  fullView,
  onToggleFullView,
  onBack,
}: {
  account: Account
  fullView: boolean
  onToggleFullView: () => void
  onBack: () => void
}) {
  const meta = providerMeta(account.provider)
  const [status, setStatus] = useState(meta.loadingLabel)
  const [panelOpen, setPanelOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevAccountRef = useRef({ id: account.id, provider: account.provider })
  // Ganti akun -> tutup panel milik akun lama.
  useEffect(() => {
    const prev = prevAccountRef.current
    if (prev.id !== account.id || prev.provider !== account.provider) {
      void invoke("close_ext_panel", { accountId: prev.id, provider: prev.provider }).catch(() => {})
      prevAccountRef.current = { id: account.id, provider: account.provider }
      setPanelOpen(false)
    }
  }, [account.id, account.provider])
  // Unmount (tombol back) -> tutup panel.
  useEffect(() => {
    return () => {
      const prev = prevAccountRef.current
      void invoke("close_ext_panel", { accountId: prev.id, provider: prev.provider }).catch(() => {})
    }
  }, [])
  const togglePanel = () => {
    if (panelOpen) {
      void invoke("close_ext_panel", { accountId: account.id, provider: account.provider }).catch(() => {})
      setPanelOpen(false)
      return
    }
    const host = containerRef.current?.getBoundingClientRect()
    if (!host) return
    const w = 380
    setPanelOpen(true)
    // Estimasi dulu; ResizeObserver di bawah mengoreksi begitu dock ter-render.
    void invoke("open_ext_panel", {
      accountId: account.id,
      provider: account.provider,
      x: host.right - w,
      y: host.top,
      width: w,
      height: host.height,
    }).catch(() => setPanelOpen(false))
  }
  useEffect(() => {
    // Reset scroll konten utama ke atas SEBELUM mengukur rect.
    // Kalau user membuka akun dari list yang ter-scroll, koordinat webview
    // native ikut bergeser dan menutupi header. scrollTo sinkron + rect
    // memaksa reflow, jadi hasil ukur selalu benar.
    document.querySelector(".app > .content")?.scrollTo({ top: 0 });
    setStatus(providerMeta(account.provider).loadingLabel)
    let cancelled = false
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    invoke("open_google_flow", {
      accountId: account.id,
      provider: account.provider,
      customUrl: account.customUrl || null,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
      .then(() => {
        if (!cancelled) setStatus(`${displayProviderName(account)} ready`)
        containerRef.current?.dispatchEvent(new Event("flowmanager-webview-ready"))
      })
      .catch((error) => {
        console.error(`${displayProviderName(account)} WebView failed`, error)
        if (!cancelled) setStatus(`Unable to open ${displayProviderName(account)}. Please try again.`)
      })
    return () => {
      cancelled = true
      void invoke("close_google_flow", { accountId: account.id, provider: account.provider })
    }
  }, [account.id, account.provider])
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const syncBounds = () => {
      const rect = container.getBoundingClientRect()
      void invoke("resize_google_flow", { accountId: account.id, provider: account.provider, x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      if (panelRef.current) {
        const pr = panelRef.current.getBoundingClientRect()
        if (pr.width > 0 && pr.height > 0) {
          void invoke("resize_ext_panel", { accountId: account.id, provider: account.provider, x: pr.left, y: pr.top, width: pr.width, height: pr.height })
        }
      }
    }
    const onReady = () => syncBounds()
    container.addEventListener("flowmanager-webview-ready", onReady)
    const observer = new ResizeObserver(syncBounds)
    observer.observe(container)
    if (panelRef.current) observer.observe(panelRef.current)
    syncBounds()
    return () => {
      observer.disconnect()
      container.removeEventListener("flowmanager-webview-ready", onReady)
    }
  }, [fullView, panelOpen, account.id, account.provider])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullView) onToggleFullView()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [fullView, onToggleFullView])
  return (
    <div className={`flow-shell ${panelOpen ? "panel-open" : ""}`}>
      <div className="flow-bar">
        <button className="back" onClick={onBack}>‹ Accounts</button>
        <span>{status}</span>
        <div className="flow-controls">
          {normalizeProvider(account.provider) === "google" && (
            <button
              className={panelOpen ? "extbtn active" : "extbtn"}
              onClick={togglePanel}
              title="Tampilkan/sembunyikan panel AUTOFLOW extension"
            >
              ⚡ AUTOFLOW
            </button>
          )}
          <div className="current-account" title={`${account.name} — ganti akun lewat list di sidebar`}>
            <img src={avatarFor(account)} alt="" />
            <span>{account.name}</span>
            <span className={`provider-badge provider-${normalizeProvider(account.provider)}`}>{badgeFor(account)}</span>
          </div>
          <button className="fullscreen" onClick={onToggleFullView}>
            {fullView ? "Exit Full View" : "Full View"}
          </button>
        </div>
      </div>
      <div className="flow-view">
        <div ref={containerRef} className="webview-host" aria-label={`${providerMeta(account.provider).name} WebView`} />
        {panelOpen && <div ref={panelRef} className="ext-dock" aria-label="AUTOFLOW extension panel" />}
      </div>
    </div>
  )
}

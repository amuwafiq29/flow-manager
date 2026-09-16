export type ProviderId = "google" | "dola" | "migoo" | "chatgpt" | "minimax" | "leonardo" | "custom"

export type StoredAccount = {
  id: string
  name: string
  email: string | null
  avatarUrl: string | null
  avatar: string
  favorite: boolean
  order: number
  provider: ProviderId
  customUrl?: string | null
}
const STORAGE_KEY = "flowmanager-accounts"
const LEGACY_STORAGE_KEY = "flowpilot-accounts"

const KNOWN_PROVIDERS: ProviderId[] = ["google", "dola", "migoo", "chatgpt", "minimax", "leonardo", "custom"]

function normalizeProvider(value: unknown): ProviderId {
  return typeof value === "string" && (KNOWN_PROVIDERS as string[]).includes(value)
    ? (value as ProviderId)
    : "google"
}

function isAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false
  const a = value as Partial<StoredAccount>
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    (a.email === null || typeof a.email === "string") &&
    (a.avatarUrl === null || typeof a.avatarUrl === "string") &&
    typeof a.avatar === "string" &&
    typeof a.favorite === "boolean" &&
    typeof a.order === "number" &&
    (a.provider === undefined || typeof a.provider === "string") &&
    (a.customUrl === undefined || a.customUrl === null || typeof a.customUrl === "string")
  )
}

function normalize(accounts: StoredAccount[]): StoredAccount[] {
  return [...accounts]
    .map((a) => ({
      ...a,
      provider: normalizeProvider(a.provider),
      customUrl: typeof a.customUrl === "string" ? a.customUrl : null,
    }))
    .sort((a, b) => a.order - b.order)
}

export async function loadAccounts(): Promise<StoredAccount[]> {
  try {
    const native = await invoke<unknown>("load_accounts")
    if (native !== null && native !== undefined) {
      if (!Array.isArray(native) || !native.every(isAccount)) throw new Error("Invalid stored account data")
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      return normalize(native)
    }

    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || !parsed.every(isAccount)) throw new Error("Invalid stored account data")
      const next = normalize(parsed)
      await invoke("save_accounts", { accounts: next })
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      return next
    }
    return []
  } catch (error) {
    console.error("FlowManager account data could not be loaded", error)
    return []
  }
}
export async function saveAccounts(accounts: StoredAccount[]) {
  try {
    if (!accounts.every(isAccount)) throw new Error("Invalid account data")
    await invoke("save_accounts", { accounts: normalize(accounts) })
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch (error) {
    console.error("FlowManager account data could not be saved", error)
  }
}
import { invoke } from "@tauri-apps/api/core"

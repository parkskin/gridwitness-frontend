import { useSyncExternalStore } from 'react'

// 분석 서버(FastAPI) 연결 설정.

// 실제 서버 주소.
// - Vite 개발 서버(vite.config.ts)와 Vercel(vercel.json)은 같은 출처의 /gw-api 를 이 주소로 프록시한다
// - GitHub Pages 는 정적 호스팅이라 프록시가 없다 (/gw-api → 404). 현재 ParksKin Pages 출처는 API CORS에
//   등록되어 있으므로 서버 주소로 바로 요청한다.
export const UPSTREAM_API = 'https://gridwitness-api.https.gsmsv.site'
const PROXY_API = '/gw-api'
/** 프록시가 없는 정적 호스팅(GitHub Pages)에서 열렸는지 */
const STATIC_HOST = typeof location !== 'undefined' && location.hostname.endsWith('github.io')
export const DEFAULT_API = STATIC_HOST ? UPSTREAM_API : PROXY_API

const URL_KEY = 'gridwitness.api.url'
export const API_CHANGED_EVENT = 'gridwitness-api-change'
const tokens = new Map<string, string>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function apiBase(): string {
  const raw = read(URL_KEY) ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? DEFAULT_API
  const url = raw.trim().replace(/\/+$/, '')
  // 프록시가 있는 곳: 직접 주소는 CORS 에 막히므로 프록시 경로로 / 정적 호스팅: 프록시 경로는 없으므로 직접 주소로
  if (STATIC_HOST) return url === PROXY_API ? UPSTREAM_API : url
  return url === UPSTREAM_API ? PROXY_API : url
}

export function setApiBase(url: string) {
  const clean = url.trim().replace(/\/+$/, '') || DEFAULT_API
  if (clean !== PROXY_API) {
    let parsed: URL
    try { parsed = new URL(clean) } catch { throw new Error('http:// 또는 https://로 시작하는 서버 주소를 입력하세요.') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('사용자 정보가 없는 http(s) 서버 주소를 입력하세요.')
  }
  try {
    localStorage.setItem(URL_KEY, clean)
  } catch {
    // 저장 불가 환경은 무시
  }
  health = { state: 'idle', detail: '', checkedAt: null }
  capabilities = { state: 'idle', data: null, detail: '', checkedAt: null }
  listeners.forEach((l) => l())
  capabilityListeners.forEach((l) => l())
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(API_CHANGED_EVENT))
}

const tokenKey = () => `gridwitness.api.token.${encodeURIComponent(apiBase())}`
export function getApiToken(): string {
  try { return sessionStorage.getItem(tokenKey()) ?? tokens.get(apiBase()) ?? '' } catch { return tokens.get(apiBase()) ?? '' }
}
export function setApiToken(token: string) {
  tokens.set(apiBase(), token.trim())
  try {
    if (token.trim()) sessionStorage.setItem(tokenKey(), token.trim())
    else sessionStorage.removeItem(tokenKey())
  } catch { /* 이 세션의 메모리에서 유지 */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(API_CHANGED_EVENT))
}
export function apiHeaders(headers?: HeadersInit): Headers {
  const out = new Headers(headers)
  const token = getApiToken()
  if (token) out.set('authorization', `Bearer ${token}`)
  return out
}

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** 모든 API 호출의 시간 제한·취소·접근 코드·오류 안내를 같은 방식으로 처리한다. */
export async function apiRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController()
  const external = init.signal
  let timedOut = false
  const abort = () => controller.abort(external?.reason)
  if (external?.aborted) abort()
  else external?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1, timeoutMs))
  try {
    const response = await fetch(`${apiBase()}${path}`, { ...init, headers: apiHeaders(init.headers), signal: controller.signal })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string; message?: string; detail?: string | { msg?: string }[] }
      const detail = typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) ? body.detail.map((e) => e.msg).filter(Boolean).join(' · ') : ''
      const fallback = response.status === 401 || response.status === 403 ? '접근 코드가 필요하거나 권한이 없습니다. 설정에서 확인하세요.' : `서버 오류 (${response.status})`
      throw new ApiError(body.message || detail || fallback, response.status, body.code)
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (timedOut) throw new Error(`${Math.max(0.01, timeoutMs / 1000)}초 안에 서버가 응답하지 않았습니다. 다시 시도하세요.`)
    if (external?.aborted) throw new DOMException('요청을 취소했습니다.', 'AbortError')
    if (error instanceof SyntaxError) throw new Error('서버 응답을 읽지 못했습니다. 서버 버전과 주소를 확인하세요.')
    throw new Error('분석 서버에 연결할 수 없습니다. 주소·네트워크를 확인하세요.')
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', abort)
  }
}

export interface ModelCapability {
  country: string
  key?: string
  available: boolean
  channels: string[]
  labels: string[]
  rows: number
  sampling_rate_hz: number
  system_frequency_hz: number
  version?: string
}
export interface Capabilities {
  models: ModelCapability[]
  assistant: { configured: boolean; model: string | null; available?: boolean | null; timeout_seconds?: number }
  auth: { required: boolean }
}
/** The API's available flag only verifies that the configured model appears in Ollama's model list. */
export function assistantStatusLabel(assistant: Capabilities['assistant']): string {
  if (!assistant.configured) return 'LLM 미설정 · 서버 규칙으로 답변'
  if (assistant.available === false) return '설정 모델을 서버에서 확인하지 못함 · 서버 규칙으로 대체'
  if (assistant.available === true) return '설정 모델 목록 확인됨 · 실제 답변 채택 여부는 대화 결과에서 확인'
  return 'LLM 설정됨 · 모델 목록 확인 중'
}
export interface CapabilityState { state: 'idle' | 'checking' | 'ok' | 'down'; data: Capabilities | null; detail: string; checkedAt: number | null }
let capabilities: CapabilityState = { state: 'idle', data: null, detail: '', checkedAt: null }
const capabilityListeners = new Set<() => void>()
export const getCapabilities = (): CapabilityState => capabilities
export function useCapabilities(): CapabilityState {
  return useSyncExternalStore((l) => { capabilityListeners.add(l); return () => capabilityListeners.delete(l) }, () => capabilities)
}
export async function checkCapabilities(): Promise<CapabilityState> {
  const base = apiBase()
  capabilities = { ...capabilities, state: 'checking' }
  capabilityListeners.forEach((l) => l())
  try {
    const data = await apiRequest<Capabilities>('/api/v1/capabilities', {}, 8000)
    if (!data.assistant || !data.auth || !Array.isArray(data.models)) throw new Error('서버의 기능 상태 응답이 올바르지 않습니다.')
    if (base === apiBase()) capabilities = { state: 'ok', data, detail: '', checkedAt: Date.now() }
  } catch (error) {
    if (base === apiBase()) capabilities = { state: 'down', data: null, detail: error instanceof ApiError && error.status === 404 ? '서버에 기능 상태 API가 없습니다. 서버 업데이트가 필요합니다.' : (error as Error).message, checkedAt: Date.now() }
  }
  capabilityListeners.forEach((l) => l())
  return capabilities
}

// ── 서버 상태 ───────────────────────────────────────────
export interface Health {
  state: 'idle' | 'checking' | 'ok' | 'down'
  detail: string
  checkedAt: number | null
}

let health: Health = { state: 'idle', detail: '', checkedAt: null }
const listeners = new Set<() => void>()
const set = (h: Health) => {
  health = h
  listeners.forEach((l) => l())
}

export async function checkHealth(): Promise<Health> {
  const base = apiBase()
  set({ ...health, state: 'checking' })
  try {
    const body = await apiRequest<{ status?: string; database?: string }>('/health', {}, 8000)
    const ok = body.status === 'ok'
    if (base === apiBase()) set({ state: ok ? 'ok' : 'down', detail: ok ? `서버 정상 · 데이터베이스 ${body.database ?? '?'}` : '서버 상태 응답 이상', checkedAt: Date.now() })
  } catch (e) {
    if (base === apiBase()) set({ state: 'down', detail: (e as Error).message, checkedAt: Date.now() })
  }
  return health
}

export function useBackendHealth(): Health {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => health,
  )
}

/** 앱이 보이는 동안 주기적으로 갱신하며, 탭·접근 코드 변경 시에도 즉시 다시 확인한다. */
export function monitorBackend(): () => void {
  const check = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void Promise.allSettled([checkHealth(), checkCapabilities()])
  }
  check()
  const timer = setInterval(check, 30_000)
  window.addEventListener('online', check)
  window.addEventListener(API_CHANGED_EVENT, check)
  document.addEventListener('visibilitychange', check)
  return () => {
    clearInterval(timer)
    window.removeEventListener('online', check)
    window.removeEventListener(API_CHANGED_EVENT, check)
    document.removeEventListener('visibilitychange', check)
  }
}

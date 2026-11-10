import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { IncidentBanner, IncidentSheet, IncidentWatcher } from './components/LiveIncident'
import { IconAnalysis, IconDashboard, IconShieldCheck, IconDatabase, IconLogo, IconMenu, IconBolt, IconSettings, IconVillage } from './components/Icons'
import { Dot, PageSkeleton } from './components/ui'
import { useActor } from './lib/actor'
import { monitorBackend, useBackendHealth } from './lib/backend'
import { toggleAlerts, useAlertsOn } from './lib/notify'
import { connectSerial, DEVICE_INFO, useVillage } from './lib/village'
const GlobalAssistant = lazy(() => import('./components/GlobalAssistant'))
const CaseDetail = lazy(() => import('./pages/CaseDetail'))
const CaseList = lazy(() => import('./pages/CaseList'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const FieldAssistant = lazy(() => import('./pages/FieldAssistant'))
const FrtuDetail = lazy(() => import('./pages/FrtuDetail'))
const Admin = lazy(() => import('./pages/Admin'))
const IncidentDetail = lazy(() => import('./pages/IncidentDetail'))
const LiveData = lazy(() => import('./pages/LiveData'))
const NewCase = lazy(() => import('./pages/NewCase'))
const PublicData = lazy(() => import('./pages/PublicData'))
const Report = lazy(() => import('./pages/Report'))
const Settings = lazy(() => import('./pages/Settings'))
const VillageLoads = lazy(() => import('./pages/VillageLoads'))

const Village = lazy(() => import('./pages/Village'))
const City = lazy(() => import('./pages/City'))

const NAV: { label: string; items: { to: string; label: string; icon: ReactNode; end?: boolean }[] }[] = [
  {
    label: '모니터링',
    items: [
      { to: '/dashboard', label: '대시보드', icon: <IconDashboard /> },
      { to: '/village', label: '마을 시뮬레이션', icon: <IconVillage /> },
      { to: '/city', label: '도시 시뮬레이션', icon: <IconBolt /> },
    ],
  },
  {
    label: '분석',
    items: [
      { to: '/cases', label: '사건 기록', icon: <IconAnalysis /> },
      { to: '/public-data', label: '공공데이터 분석', icon: <IconDatabase /> },
    ],
  },
  {
    label: '관리',
    items: [
      { to: '/admin', label: '관리자', icon: <IconShieldCheck /> },
      { to: '/settings', label: '설정', icon: <IconSettings /> },
    ],
  },
]

/** 상단 바에 바로 보이는 주요 화면 (나머지는 ☰ 메뉴) */
const TOP_NAV = [
  { to: '/dashboard', label: '대시보드' },
  { to: '/village', label: '3D 마을' },
  { to: '/cases', label: '사건 기록' },
  { to: '/public-data', label: '공공데이터' },
  { to: '/city', label: '도시' },
]

/** 예전 주소(/history/:id)로 들어와도 사건 화면으로 보냄 */
function HistoryRedirect() {
  const { id = '' } = useParams()
  return <Navigate to={`/cases/${id}`} replace />
}

/** 사이드바 하단: 데이터 출처와 연결 상태를 한 곳에서만 보여줌 */
function DeviceStatus() {
  const snap = useVillage()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const ago = snap.lastPacketAt ? Math.max(0, Math.round((now - snap.lastPacketAt) / 1000)) : null
  const live = snap.connected && ago !== null && ago < 3
  const health = useBackendHealth()
  return (
    <>
    <Link to="/settings" className="device-status" title="분석 서버 설정">
      <Dot tone={health.state === 'ok' ? 'ok' : health.state === 'down' ? 'err' : 'warn'} />
      <strong>분석 서버</strong>
      <span>{health.state === 'ok' ? '서버 정상' : health.state === 'down' ? '연결 안 됨' : '확인 중'}</span>
    </Link>
    <Link to="/settings" className="device-status" title="데이터 출처 설정">
      <Dot tone={live ? 'ok' : snap.connected ? 'warn' : 'err'} live={live} />
      <strong>{snap.source === 'MOCK' ? '시뮬레이터' : '실측 장치'}</strong>
      <span>
        {snap.connected ? DEVICE_INFO[snap.source].deviceId : '연결 끊김'}
        {ago !== null && snap.connected && ` · ${ago}초 전`}
      </span>
    </Link>
    </>
  )
}

/** 실측 장치 연결이 끊겼을 때 어느 화면에서든 한 번에 다시 연결하는 배너 */
function ReconnectBanner() {
  const snap = useVillage()
  const [busy, setBusy] = useState(false)
  if (snap.source !== 'SERIAL' || snap.connected || !snap.reconnecting) return null
  async function connect() {
    setBusy(true)
    try {
      await connectSerial()
    } catch {
      // 포트 선택 창을 닫은 경우 등은 그대로 둠
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="alert alert-warn reconnect-banner no-print" role="status">
      <span>
        <strong>실측 장치 연결이 끊겼습니다.</strong>{' '}
        {snap.needsGrant ? '이 브라우저는 이전에 허용한 포트를 기억하지 못해 새로고침하면 한 번 다시 허용해야 합니다.' : 'USB를 꽂으면 자동으로 다시 연결합니다.'}{' '}
        <button className="btn btn-sm btn-primary" onClick={connect} disabled={busy}>{busy ? '포트 선택 중…' : '다시 연결'}</button>
      </span>
    </div>
  )
}

/** 사건 알림(소리·브라우저 알림) 켜고 끄기 */
function AlertBell() {
  const on = useAlertsOn()
  return (
    <button type="button" className={`tb-icon ${on ? 'active' : ''}`} onClick={() => void toggleAlerts()} title={on ? '사건 알림 켜짐 (누르면 끔)' : '사건 알림 꺼짐 (누르면 켬)'} aria-label={on ? '사건 알림 끄기' : '사건 알림 켜기'} aria-pressed={on}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        {!on && <path d="M3 3l18 18" />}
      </svg>
    </button>
  )
}

/** 상단 바 오른쪽: 데이터 출처·연결 상태를 점 하나와 짧은 글자로 */
function StatusChip() {
  const snap = useVillage()
  const health = useBackendHealth()
  const live = snap.connected && snap.status !== 'NO_DATA'
  return (
    <Link to="/settings" className="tb-status" title={`분석 서버: ${health.state === 'ok' ? '정상' : health.state === 'down' ? '연결 안 됨' : '확인 중'}`}>
      <Dot tone={live ? 'ok' : 'err'} live={live} />
      <span>{snap.source === 'MOCK' ? '시뮬레이터' : live ? '실측 연결됨' : '장치 끊김'}</span>
      {health.state === 'down' && <span className="tb-warn">서버 끊김</span>}
    </Link>
  )
}

/** 모든 화면 위의 얇은 상단 바: 로고 · 주요 화면 · 연결 상태 · 관리. 좁은 화면에서는 ☰ 하나로 접힘 */
function TopBar({ actor }: { actor: string }) {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  return (
    <header className="topbar no-print">
      <Link to="/" className="tb-brand" aria-label="GridWitness 소개 화면">
        <span className="brand-mark"><IconLogo /></span>
        <span>GridWitness</span>
      </Link>
      <nav className="tb-nav" aria-label="주요 화면">
        {TOP_NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className="tb-link">{n.label}</NavLink>
        ))}
      </nav>
      <div className="tb-right">
        <StatusChip />
        <AlertBell />
        <NavLink to="/admin" className="tb-icon" title="관리자" aria-label="관리자"><IconShieldCheck /></NavLink>
        <NavLink to="/settings" className="tb-icon" title="설정" aria-label="설정"><IconSettings /></NavLink>
        <button type="button" className="tb-icon tb-burger" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="메뉴"><IconMenu /></button>
      </div>
      {open && (
        <div className="tb-pop" onClick={() => setOpen(false)}>
          {NAV.map((g) => (
            <div key={g.label} className="float-group">
              <div className="float-label">{g.label}</div>
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} className="float-link">{n.icon}<span>{n.label}</span></NavLink>
              ))}
            </div>
          ))}
          <div className="float-foot">
            <DeviceStatus />
            <div className="side-user">{actor}</div>
          </div>
        </div>
      )}
    </header>
  )
}

/** 앱 화면 틀(사이드바 + 페이지). 소개 화면의 노트북에도 같은 것을 씀 */
export function Shell({ extraRoutes }: { extraRoutes?: ReactNode } = {}) {
  useEffect(monitorBackend, [])
  const [actor] = useActor()
  const location = useLocation()
  const wide = location.pathname === '/city'
  // 대시보드(마을 시뮬)는 사이드바 없이 화면 전체를 쓰고, 메뉴는 왼쪽 위 떠 있는 버튼으로
  const immersive = location.pathname === '/village'

  return (
    <div className={`app no-sidebar with-topbar ${immersive ? 'immersive' : ''}`}>
      <TopBar actor={actor} />
      <IncidentWatcher />
      <IncidentBanner />
      <IncidentSheet />
      <Suspense fallback={null}><GlobalAssistant /></Suspense>

      <div className="main">
        <ReconnectBanner />
        <main key={location.pathname} className={`page ${wide ? 'wide' : ''}`}>
          <Suspense fallback={<PageSkeleton />}>
            <Routes location={location}>
              {extraRoutes}
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/village" element={<Village />} />
              <Route path="/village/loads" element={<VillageLoads />} />
              <Route path="/live" element={<LiveData />} />
              <Route path="/frtu" element={<FrtuDetail />} />
              <Route path="/incidents/:id" element={<IncidentDetail />} />
              <Route path="/city" element={<City />} />
              <Route path="/cases" element={<CaseList />} />
              <Route path="/cases/new" element={<NewCase />} />
              <Route path="/cases/:id" element={<CaseDetail />} />
              <Route path="/field/:id" element={<FieldAssistant />} />
              <Route path="/impact" element={<Navigate to="/public-data#outage" replace />} />
              <Route path="/report/:kind/:id" element={<Report />} />
              <Route path="/public-data" element={<PublicData />} />
              <Route path="/history" element={<Navigate to="/cases" replace />} />
              <Route path="/history/:id" element={<HistoryRedirect />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<div className="empty"><h1>화면을 찾을 수 없습니다</h1><p>주소를 확인하거나 대시보드에서 다시 시작하세요.</p><Link className="btn btn-primary" to="/dashboard">대시보드로</Link></div>} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  )
}


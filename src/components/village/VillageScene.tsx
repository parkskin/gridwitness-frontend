import { Environment, Lightformer, Line, OrbitControls, Stars } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { CatmullRomCurve3, Vector3, type Group, type Mesh } from 'three'
import { FRTUS, frtuDisplayViews, locateFault, type FrtuId } from '../../lib/frtu'
import { IOT_CHANNELS, lightView, speech, type ChannelId, type NodeStatus, type VillageSnapshot } from '../../lib/village'
import House from './House'
import { BOX_FLOOR, HOUSE_POS, LAMP_POS, POLES, routePoints, type HouseChannel, type LampChannel } from './layout'
import { Frtu, Pole, STATUS_COLOR, StreetLamp } from './Props'
import Terrain, { WiringBox } from './Terrain'
import { skyGradient } from './textures'
import Trees from './Trees'
import Underground, { partCenter } from './Underground'
import type { PartId } from '../../lib/hardware'

// ── 전선 + 전류 흐름 ─────────────────────────────────────
/** hot: 실시간 사건의 고장 분기에 속한 선 → 빨갛게 깜빡임 */
function Feeder({ id, status, flowing, night, hot = false }: { id: ChannelId; status: NodeStatus; flowing: boolean; night: boolean; hot?: boolean }) {
  const pts = useMemo(() => routePoints(id), [id])
  const curve = useMemo(() => new CatmullRomCurve3(pts.map((p) => new Vector3(...p))), [pts])
  const N = 8
  const refs = useRef<(Mesh | null)[]>([])
  const phase = useRef(0)
  const line = useRef<{ material: { opacity: number; transparent: boolean } } | null>(null)
  useFrame(({ clock }, dt) => {
    phase.current = (phase.current + dt * 0.09) % 1
    refs.current.forEach((m, k) => m && m.position.copy(curve.getPointAt((phase.current + k / N) % 1)))
    if (line.current) {
      line.current.material.transparent = hot
      line.current.material.opacity = hot ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 6)) : 1
    }
  })
  const idle = !hot && (status === 'NORMAL' || status === 'OFF' || status === 'NO_DATA')
  const wireColor = hot ? STATUS_COLOR.FAULT : idle ? (night ? '#8090a6' : '#2b2f33') : STATUS_COLOR[status]
  return (
    <group>
      <Line ref={line as never} points={pts} color={wireColor} lineWidth={hot ? 3.4 : idle ? 1.4 : 2.6} />
      {flowing &&
        Array.from({ length: N }, (_, k) => (
          <mesh key={k} ref={(m) => void (refs.current[k] = m)}>
            <sphereGeometry args={[status === 'FAULT' ? 0.12 : 0.075, 12, 12]} />
            <meshBasicMaterial color={STATUS_COLOR[status]} toneMapped={false} />
          </mesh>
        ))}
    </group>
  )
}

const Lights = memo(function Lights({ night }: { night: boolean }) {
  return (
    <>
      <hemisphereLight args={night ? ['#3b4d7a', '#141a26', 0.35] : ['#eaf4ff', '#4d6b38', 0.45]} />
      <directionalLight
        position={night ? [10, 22, -8] : [-14, 24, 12]}
        intensity={night ? 0.45 : 2.1}
        color={night ? '#9db4ff' : '#fff1dc'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-28}
        shadow-camera-right={28}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-far={80}
      />
      {/* 반사용 환경광 (외부 HDR 없이 조명판으로 구성) */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={night ? 0.3 : 0.9} color={night ? '#5c6f9c' : '#ffffff'} position={[0, 10, 0]} rotation-x={Math.PI / 2} scale={[30, 30, 1]} />
        <Lightformer form="rect" intensity={night ? 0.2 : 0.6} color={night ? '#2c3a5c' : '#cfe6ff'} position={[-15, 5, 10]} rotation-y={Math.PI / 2} scale={[20, 6, 1]} />
        <Lightformer form="rect" intensity={night ? 0.2 : 0.4} color={night ? '#2c3a5c' : '#ffe8c7'} position={[15, 5, -10]} rotation-y={-Math.PI / 2} scale={[20, 6, 1]} />
      </Environment>
    </>
  )
})

/** 프레임 수 제한: 필요한 만큼만 다시 그림 (frameloop="demand") */
function FrameDriver({ fps, active }: { fps: number; active: boolean }) {
  const invalidate = useThree((st) => st.invalidate)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => invalidate(), 1000 / fps)
    return () => clearInterval(id)
  }, [fps, active, invalidate])
  return null
}

/** 그림자 맵은 매 프레임이 아니라 장면이 바뀔 때만 다시 그림 (움직이는 차는 그림자 없음) */
function StaticShadows({ version }: { version: string }) {
  const gl = useThree((st) => st.gl)
  const invalidate = useThree((st) => st.invalidate)
  useEffect(() => {
    gl.shadowMap.autoUpdate = false
    const refresh = () => {
      gl.shadowMap.needsUpdate = true
      invalidate()
    }
    refresh()
    // 인스턴스 나무 배치 등이 끝난 뒤 한 번 더
    const t = setTimeout(refresh, 400)
    return () => clearTimeout(t)
  }, [gl, invalidate, version])
  return null
}

const Effects = memo(function Effects({ night }: { night: boolean }) {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <N8AO aoRadius={1.2} distanceFalloff={0.8} intensity={night ? 1.5 : 2.6} halfRes quality="performance" />
      <Bloom mipmapBlur luminanceThreshold={night ? 0.6 : 0.95} luminanceSmoothing={0.2} intensity={night ? 1.4 : 0.35} radius={0.7} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
      <Vignette offset={0.25} darkness={night ? 0.7 : 0.45} />
    </EffectComposer>
  )
})

/** 캔버스가 화면에 보이고 탭이 활성일 때만 렌더링 */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(true)
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 })
    io.observe(el)
    const onVis = () => setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
  return [ref, visible && tabVisible] as const
}

/** 카메라 목표: 지상 / 지하 전체(위에서 내려다봄) / 부품 확대. 목표가 바뀌면 부드럽게 따라감 */
type Shot = { pos: Vector3; target: Vector3 }
const SURFACE: Shot = { pos: new Vector3(-9, 19, 25), target: new Vector3(0, 0, 0) }
const UNDER: Shot = { pos: new Vector3(-4, BOX_FLOOR + 35, 22), target: new Vector3(-4, BOX_FLOOR, -1.5) }
/** FRTU 3대의 자리: 인입은 변전소에서 나온 첫 전봇대, 두 분기 FRTU는 주택·가로등 선이 갈라지는 전봇대에 나란히 */
const FRTU_PLACE: Record<FrtuId, { pole: number; dx: number; labelY: number }> = {
  inlet: { pole: 0, dx: 0, labelY: 2.7 },
  house: { pole: 1, dx: -0.6, labelY: 3.6 },
  lamp: { pole: 1, dx: 0.6, labelY: 2.5 },
}
const frtuShot = (id: FrtuId): Shot => {
  const p = POLES[FRTU_PLACE[id].pole]
  return { pos: new Vector3(p[0] + 5.5, 5.5, p[2] + 9.5), target: new Vector3(p[0] + 2.2, 1.6, p[2]) }
}
function partShot(id: PartId): Shot {
  const [x, y, z] = partCenter(id)
  return { pos: new Vector3(x, y + 10.5, z + 4.5), target: new Vector3(x, y, z - 0.6) }
}

function CameraRig({ shot }: { shot: Shot }) {
  const camera = useThree((st) => st.camera)
  const controls = useThree((st) => st.controls) as unknown as { target: Vector3; update: () => void } | null
  const moving = useRef(false)
  useEffect(() => {
    moving.current = true
  }, [shot])
  useFrame((_, dt) => {
    if (!moving.current || !controls) return
    const k = 1 - Math.exp(-dt * 3.5)
    camera.position.lerp(shot.pos, k)
    controls.target.lerp(shot.target, k)
    controls.update()
    if (camera.position.distanceTo(shot.pos) < 0.05) moving.current = false
  })
  return null
}

/** 지면 판과 그 위 모든 것. away면 판을 위·뒤로 치워 아래 배선 상자를 위에서 보이게 함 */
const AWAY = new Vector3(0, 34, -80)
const HOME = new Vector3(0, 0, 0)
function Lift({ away, children }: { away: boolean; children: React.ReactNode }) {
  const ref = useRef<Group>(null)
  const gl = useThree((st) => st.gl)
  useFrame((_, dt) => {
    const g = ref.current
    if (!g) return
    const goal = away ? AWAY : HOME
    if (g.position.distanceTo(goal) < 0.01) {
      g.visible = !away
      return
    }
    g.visible = true
    g.position.lerp(goal, 1 - Math.exp(-dt * 3))
    // 움직이는 동안만 그림자 다시 계산
    gl.shadowMap.needsUpdate = true
  })
  return <group ref={ref}>{children}</group>
}

const Static = memo(function Static() {
  return (
    <>
      <Terrain />
      <Trees />
      {POLES.map((p, k) => <Pole key={k} p={p} transformer={k === 2} />)}
    </>
  )
})

export default function VillageScene({
  snap,
  selected,
  onSelect,
  night = false,
  fx = false,
  underground = false,
  selectedPart = null,
  onPart = () => {},
  showPins = false,
  frtu = null,
  onFrtu,
}: {
  snap: VillageSnapshot
  selected: ChannelId | null
  onSelect: (id: ChannelId | null) => void
  night?: boolean
  /** 고화질: AO·블룸 후처리, 높은 해상도, 60fps */
  fx?: boolean
  /** 바닥판 내부 배선 보기 */
  underground?: boolean
  selectedPart?: PartId | null
  onPart?: (id: PartId | null) => void
  showPins?: boolean
  /** 골라서 확대해 보는 FRTU */
  frtu?: FrtuId | null
  /** 있으면 FRTU 3대를 그리고 누를 수 있게 함 */
  onFrtu?: (id: FrtuId) => void
}) {
  const shot = useMemo(() => (underground ? (selectedPart ? partShot(selectedPart) : UNDER) : frtu ? frtuShot(frtu) : SURFACE), [underground, selectedPart, frtu])
  const fv = frtuDisplayViews(snap)
  // 지금 고장 구간 (고장표시로 좁힌 분기) → 그 분기의 전선을 강조
  const hotScope = locateFault(snap).scope
  const bg = useMemo(() => (night ? skyGradient('#070d1c', '#1b2b4d') : skyGradient('#9fcbf2', '#e9f3fb')), [night])
  const [wrap, active] = useOnScreen<HTMLDivElement>()
  const dpr = fx ? Math.min(window.devicePixelRatio, 1.75) : Math.min(window.devicePixelRatio, 1.25)
  return (
    <div ref={wrap} style={{ width: '100%', height: '100%' }}>
      <Canvas
        key={fx ? 'hq' : 'std'}
        shadows
        frameloop="demand"
        // CSS로 줄여 보여주는 곳(소개 화면 노트북)에서도 실제 레이아웃 크기로 측정
        resize={{ offsetSize: true }}
        dpr={dpr}
        camera={{ position: [-9, 19, 25], fov: 44, near: 0.5, far: 200 }}
        gl={{ antialias: !fx, powerPreference: fx ? 'high-performance' : 'default' }}
        onPointerMissed={() => (underground ? onPart(null) : onSelect(null))}
      >
        <FrameDriver fps={fx ? 60 : 30} active={active} />
        <StaticShadows version={`${night}`} />
        <primitive attach="background" object={bg} />
        <Lights night={night} />
        {night && <Stars radius={80} depth={30} count={1500} factor={3} fade speed={0} />}

        <Lift away={underground}>
          <Static />
          {onFrtu &&
            FRTUS.map((f) => (
              <Frtu
                key={f.id}
                p={POLES[FRTU_PLACE[f.id].pole]}
                dx={FRTU_PLACE[f.id].dx}
                labelY={FRTU_PLACE[f.id].labelY}
                name={f.short}
                status={fv[f.id].status}
                fi={fv[f.id].fi !== 'NONE'}
                selected={frtu === f.id}
                onSelect={() => onFrtu(f.id)}
              />
            ))}
          {IOT_CHANNELS.map((c) => {
            const view = lightView(snap.leds[c.id], snap)
            const hot = hotScope === 'BOTH' || hotScope === 'UPSTREAM' || (hotScope === 'HOUSE' && c.kind === 'HOUSE') || (hotScope === 'LAMP' && c.kind === 'LAMP')
            return <Feeder key={c.id} id={c.id} status={view.status} flowing={snap.leds[c.id].lit} night={night} hot={hot} />
          })}
          {IOT_CHANNELS.map((c) => {
            const view = lightView(snap.leds[c.id], snap)
            return c.kind === 'HOUSE' ? (
              <House key={c.id} h={snap.leds[c.id]} view={view} speech={speech(snap.leds[c.id], snap)} {...HOUSE_POS[c.id as HouseChannel]} night={night} selected={selected === c.id} onSelect={() => onSelect(c.id)} />
            ) : (
              <StreetLamp key={c.id} c={snap.leds[c.id]} view={view} speech={speech(snap.leds[c.id], snap)} {...LAMP_POS[c.id as LampChannel]} night={night} selected={selected === c.id} onSelect={() => onSelect(c.id)} />
            )
          })}
        </Lift>
        <WiringBox open={underground} />
        {underground && <Underground snap={snap} night={night} selectedPart={selectedPart} onPart={onPart} showPins={showPins} />}

        <OrbitControls makeDefault enableDamping target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.1} minDistance={6} maxDistance={55} />
        <CameraRig shot={shot} />
        {fx && <Effects night={night} />}
      </Canvas>
    </div>
  )
}

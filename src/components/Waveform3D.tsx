import { Grid, Line, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'
import type { Mesh } from 'three'
import { preprocess } from '../lib/waveform'
import { analyzeWaveform } from '../lib/faultAnalysis'
import { channelsFor } from '../types'
import Label from './three/Label'
import { COLORS } from './WaveformChart'

const X_SPAN = 12
const Z_GAP = 1.3
const Y_SCALE = 1.1

function Playhead({ playing, onPos }: { playing: boolean; onPos: (x: number) => void }) {
  const ref = useRef<Mesh>(null)
  useFrame((_, dt) => {
    if (!ref.current || !playing) return
    let x = ref.current.position.x + dt * 2.2
    if (x > X_SPAN / 2) x = -X_SPAN / 2
    ref.current.position.x = x
    onPos(x)
  })
  return (
    <mesh ref={ref} position={[-X_SPAN / 2, 0, 0]}>
      <planeGeometry args={[0.03, Y_SCALE * 2.4]} />
      <meshBasicMaterial color="#ffd43b" transparent opacity={0.9} />
    </mesh>
  )
}

/** channelNames·channelColors를 주면 교류 3상이 아닌 계측(예: 마을 FRTU 직류 전류)도 같은 3D로 그림 */
export default function Waveform3D({ matrix, samplingRateHz, systemFrequencyHz, onsetSample, recoverySeconds, channelNames, channelColors }: { matrix: number[][]; samplingRateHz: number; systemFrequencyHz: number; onsetSample?: number | null; recoverySeconds?: number | null; channelNames?: string[]; channelColors?: string[] }) {
  const [playing, setPlaying] = useState(true)
  const cursorRef = useRef<HTMLSpanElement>(null)
  const durationMs = (matrix.length / samplingRateHz) * 1000
  const channels: readonly string[] = channelNames ?? channelsFor(matrix[0]?.length ?? 0)
  const colorOf = (c: string, j: number) => channelColors?.[j] ?? COLORS[c as keyof typeof COLORS] ?? '#b8c4d4'

  const lines = useMemo(() => {
    const m = preprocess(matrix)
    const step = Math.max(1, Math.floor(m.length / 800))
    return channels.map((c, j) => {
      const z = (j - (channels.length - 1) / 2) * Z_GAP
      const pts: [number, number, number][] = []
      for (let i = 0; i < m.length; i += step) {
        pts.push([(i / (m.length - 1) - 0.5) * X_SPAN, m[i][j] * Y_SCALE, z])
      }
      return { c, z, pts, color: colorOf(c, j) }
    })
  }, [matrix, channels, channelColors])

  const markers = useMemo(() => analyzeWaveform(matrix, samplingRateHz, systemFrequencyHz), [matrix, samplingRateHz, systemFrequencyHz])
  const change = onsetSample === undefined ? markers.onset?.sample ?? null : onsetSample
  const recovery = recoverySeconds === undefined ? markers.recoverSeconds : recoverySeconds
  const changeX = change == null ? null : (change / (matrix.length - 1) - 0.5) * X_SPAN
  const recoveryX = recovery == null ? null : (recovery * samplingRateHz / (matrix.length - 1) - 0.5) * X_SPAN
  const zMax = ((channels.length - 1) / 2) * Z_GAP + 0.6

  return (
    <div className="w3d">
      <div className="w3d-toolbar">
        <button className="btn" onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ 일시정지' : '▶ 재생'}</button>
        <span className="mono small">t = <span ref={cursorRef}>0.0</span> ms / {durationMs.toFixed(1)} ms</span>
        <span className="hint" style={{ margin: 0 }}>드래그: 회전 · 휠: 확대 · 우클릭 드래그: 이동</span>
      </div>
      <Canvas camera={{ position: [9, 7, 14], fov: 42 }} dpr={[1, 2]}>
        <color attach="background" args={['#0f1d2e']} />
        <ambientLight intensity={0.8} />
        <Grid
          position={[0, -Y_SCALE - 0.3, 0]}
          args={[X_SPAN + 2, zMax * 2 + 2]}
          cellSize={0.5}
          sectionSize={2}
          cellColor="#24384f"
          sectionColor="#35557a"
          fadeDistance={40}
          infiniteGrid={false}
        />
        {lines.map(({ c, z, pts, color }) => (
          <group key={c}>
            <Line points={pts} color={color} lineWidth={1.6} />
            <Line points={[[-X_SPAN / 2, 0, z], [X_SPAN / 2, 0, z]]} color="#2c4562" lineWidth={0.6} />
            <Label lines={[c]} position={[-X_SPAN / 2 - 0.5, 0, z]} color={color} lineHeight={0.3} />
          </group>
        ))}
        {changeX != null && (
          <group position={[changeX, 0, 0]}>
            <mesh rotation={[0, Math.PI / 2, 0]}>
              <planeGeometry args={[zMax * 2, Y_SCALE * 2.4]} />
              <meshBasicMaterial color="#ff6b6b" transparent opacity={0.12} depthWrite={false} side={2} />
            </mesh>
            <Label lines={[`급변 지점 · ${((change! / samplingRateHz) * 1000).toFixed(1)} ms`]} position={[0, Y_SCALE * 1.4, -zMax]} color="#ff8787" bg="rgba(15,29,46,0.85)" lineHeight={0.26} />
          </group>
        )}
        {recoveryX != null && <group position={[recoveryX, 0, 0]}><mesh rotation={[0, Math.PI / 2, 0]}><planeGeometry args={[zMax * 2, Y_SCALE * 2.4]} /><meshBasicMaterial color="#5fb68c" transparent opacity={0.12} depthWrite={false} side={2} /></mesh><Label lines={[`초반 수준 복귀 · ${(recovery! * 1000).toFixed(1)} ms`]} position={[0, Y_SCALE * 1.4, -zMax]} color="#5fb68c" bg="rgba(15,29,46,0.85)" lineHeight={0.26} /></group>}
        <group position={[0, 0, zMax]}>
          <Playhead playing={playing} onPos={(x) => {
            if (cursorRef.current) cursorRef.current.textContent = ((x / X_SPAN + 0.5) * durationMs).toFixed(1)
          }} />
        </group>
        <Label lines={['시간 →']} position={[X_SPAN / 2 + 0.6, -Y_SCALE - 0.3, zMax]} color="#b8c4d4" lineHeight={0.3} />
        <OrbitControls makeDefault enableDamping target={[0, 0, 0]} />
      </Canvas>
      <p className="hint">채널별 max-abs 정규화 후 표시. 붉은 면(급변 관측)·초록 면(초반 수준 복귀)은 2D와 같은 계산을 사용합니다. 회복을 확인하지 못하면 초록 면을 표시하지 않습니다.</p>
    </div>
  )
}

import { DEVICE_INFO, FAULT_LABEL, IOT_MODEL, ledA, NOMINAL_V, STATUS_LABEL, THRESHOLDS, TICK_MS, type VillageEvent } from '../lib/village'
import type { DiagnosisIssue, IotCase } from '../types'

/** 마을 이상 이벤트 구간으로 IoT 사건을 만든다 . 계측 기록 그대로 보존하고 교류 파형으로 바꾸지 않음. */
export function buildIotCase(e: VillageEvent, actor: string, id: string): IotCase {
    const t = new Date().toISOString()
    const w = e.window
    // 데이터 점검: 패킷 간격·구간 길이
    const issues: DiagnosisIssue[] = []
    const gaps = w.slice(1).filter((p, k) => p.t - w[k].t > TICK_MS * 1.8).length
    if (w.length < 10) issues.push({ code: 'SHORT_WINDOW', severity: 'warning', message: `기록 구간이 ${w.length}개 샘플로 짧습니다.`, fix: '이벤트 전후 구간이 더 쌓인 뒤 등록하세요.' })
    if (gaps > 0) issues.push({ code: 'PACKET_GAP', severity: 'warning', message: `수신 간격이 끊긴 구간 ${gaps}곳이 있습니다.`, fix: '장치 연결 상태를 확인하세요.' })
    if (e.source === 'MOCK') issues.push({ code: 'SIMULATED', severity: 'info', message: '시뮬레이터 계측값입니다. 실제 INA219 기록이 아닙니다.' })
    else issues.push({ code: 'MEASURED', severity: 'info', message: '실제 모형(Arduino + INA219)에서 받은 계측값입니다.' })
    const status = issues.some((i) => i.severity === 'warning') ? 'LIMITED' : 'ACCEPTED'

    const maxResidualA = Math.max(...w.map((p) => Math.abs(p.i - p.expected)))
    const minV = Math.min(...w.map((p) => p.v))
    const findings: string[] = []
    const relayOn = w.some((p) => p.expected > 0)
    // 전원 이상 판단은 릴레이가 닫혀 있어야 할 때의 전압만 본다 (의도한 차단 중 0V는 이상이 아님)
    const minVOn = Math.min(...w.filter((p) => p.expected > 0).map((p) => p.v), Infinity)
    if (relayOn && minVOn < 1) findings.push(`릴레이가 켜져 있는데 전압이 ${minVOn.toFixed(2)}V까지 떨어졌습니다. 어댑터 전원이 끊긴 것으로 보입니다.`)
    else if (relayOn && minVOn < THRESHOLDS.vMin) findings.push(`전압이 정격 ${NOMINAL_V}V 대비 ${minVOn.toFixed(2)}V까지 낮아졌습니다 (어댑터·배선 접촉 확인).`)
    // 과전류 판단은 릴레이가 닫혀 있어야 할 때만 (차단 후 흐르는 전류는 아래 고착 항목에서 따로 봄)
    const overA = Math.max(0, ...w.filter((p) => p.expected > 0).map((p) => p.i - p.expected))
    if (overA > ledA() && !w.some((p) => p.ih !== undefined)) findings.push(`실제 전류가 예상보다 최대 ${overA.toFixed(2)}A 많습니다 (누설·단락 가능성).`)
    // INA219 두 개 구성이면 구간(주택/가로등)까지 짚고, 아니면 마을 전체로만 말함
    const houseOnly = w.some((p) => p.scope === 'HOUSE')
    const lampOnly = w.some((p) => p.scope === 'LAMP')
    const zoned = w.some((p) => p.scope === 'BOTH' || (p.scope === undefined && p.ih !== undefined && p.il !== undefined))
    const short = (i: number | undefined, e: number | undefined, v: number) => (i !== undefined && e !== undefined && e > 0 && v > 4 ? Math.round((e - i) / ledA()) : 0)
    if (zoned || houseOnly || lampOnly) {
      const zones = [
        ...(zoned || houseOnly ? [
        { name: '주택 구간(INA219 ① 0x40)', missing: Math.max(0, ...w.map((p) => short(p.ih, p.eh, p.v))), over: Math.max(0, ...w.map((p) => (p.eh ? (p.ih ?? 0) - p.eh : 0))) },
        ] : []),
        ...(zoned || lampOnly ? [
        { name: '가로등 구간(INA219 ② 0x41)', missing: Math.max(0, ...w.map((p) => short(p.il, p.el, p.v))), over: Math.max(0, ...w.map((p) => (p.el ? (p.il ?? 0) - p.el : 0))) },
        ] : []),
      ]
      for (const z of zones) {
        if (z.missing > 0) findings.push(`${z.name} 전류가 LED ${z.missing}개 분량만큼 적습니다 (LED 단선·접촉 불량 가능성). 채널 점검으로 어느 LED인지 확인할 수 있습니다.`)
        if (z.over > ledA()) findings.push(`${z.name} 전류가 예상보다 ${z.over.toFixed(2)}A 많습니다 (누설·단락 가능성).`)
      }
    } else {
      const missing = Math.max(0, ...w.map((p) => short(p.i, p.expected, p.v)))
      if (missing > 0) findings.push(`전체 전류가 LED ${missing}개 분량만큼 적습니다 (LED 단선·접촉 불량 가능성). 전체 전류만 있어 어느 LED인지는 알 수 없습니다.`)
    }
    if (w.some((p) => p.expected === 0 && p.i > 0.03)) findings.push('릴레이를 차단(D2 LOW)했는데도 전류가 계속 흐릅니다. 릴레이 접점 고착이나 우회 배선을 확인하세요.')
    findings.push(...(e.notes ?? []))
    if (findings.length === 0) findings.push('일시적인 편차로, 뚜렷한 원인 패턴은 없습니다.')

    const c: IotCase = {
      caseType: 'IOT',
      id,
      title: e.label ?? `마을 전력 ${STATUS_LABEL[e.status]} 이벤트`,
      createdAt: t,
      stage: 'ANALYZED',
      device: {
        deviceId: DEVICE_INFO[e.source].deviceId,
        sensor: DEVICE_INFO[e.source].sensor,
        scope: zoned ? '주택·가로등 분기 (INA219 2개)' : houseOnly ? '주택 분기 (INA219 0x40 실측, 가로등 미측정)' : lampOnly ? '가로등 분기 (INA219 0x41 실측, 주택 미측정)' : w.some((p) => p.ih !== undefined) ? '구간 계측 (구형 기록)' : '센서 범위 미기록',
        nominalV: NOMINAL_V,
        expectedA: e.expected,
        relayOn: e.relayOn,
        faultInjected: e.injected ? FAULT_LABEL[e.injected] : null,
      },
      window: w,
      diagnosis: { status, rows: w.length, cols: 4, issues, checkedAt: t },
      detection: {
        model: houseOnly ? 'iot-house-residual-v1 (주택 분기 실측 잔차 규칙)' : lampOnly ? 'iot-lamp-residual-v1 (가로등 분기 실측 잔차 규칙)' : IOT_MODEL,
        maxScore: e.maxScore,
        status: e.status,
        maxResidualA,
        minV,
        findings,
        limitations: [
          '5V DC 축소 모형 기준이며 22.9kV 배전선로 결과로 해석하지 않습니다.',
          zoned
            ? '구간(주택·가로등)별 전류까지만 측정하므로, 구간 안에서 어느 LED인지는 채널 점검으로 따로 확인해야 합니다.'
            : houseOnly ? '주택 분기만 측정했으며 가로등 전류는 판정하지 않았습니다. 주택 안에서 어느 LED인지는 주택 채널 점검으로 확인해야 합니다.'
            : lampOnly ? '가로등 분기만 측정했으며 주택 전류는 판정하지 않았습니다.'
            : '전체 전류만 측정하므로 어느 LED에서 문제가 생겼는지는 특정하지 않습니다.',
          '이상 점수는 예상 전류 대비 잔차로 계산한 값이며 고장 확률이 아닙니다.',
          '고장파형 4종 분류 모델과는 별개 모델입니다.',
        ],
        executedAt: t,
      },
      reviews: [],
      history: [
        { at: e.at, actor: DEVICE_INFO[e.source].deviceId, action: '이상 감지', detail: `${houseOnly ? '주택 분기 실측' : lampOnly ? '가로등 분기 실측' : zoned ? '주택·가로등 구간 합계' : '센서 범위 미기록'} · 점수 ${e.maxScore.toFixed(2)}${e.maxScore >= THRESHOLDS.fault ? ' (이상 기준 초과)' : ''}` },
        { at: t, actor, action: '사건 등록', detail: `계측 ${w.length}개 · 데이터 점검 ${status}` },
      ],
    }
  return c
}

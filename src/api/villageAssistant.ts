import { apiRequest } from '../lib/backend'
import { buildVillageEvidence } from '../lib/assistant'
import type { AnalyzedEvent } from '../lib/villageEvents'
import type { VillageSnapshot } from '../lib/village'

interface VillageReply {
  answer: string
  status: 'answered' | 'abstained' | 'refused'
  answer_mode: 'llm' | 'rules'
  llm_model: string | null
  fallback_reason: string | null
  evidence: { id: string; label: string; value: string }[]
  captured_at: string
  source: 'SERIAL' | 'MOCK'
}

export interface VillageAssistantReply {
  text: string
  mode: 'llm' | 'server_rules'
  model: string | null
  fallbackReason: string | null
  evidence: VillageReply['evidence']
  status: VillageReply['status']
}

export async function askVillageAssistant(question: string, snapshot: VillageSnapshot, events: AnalyzedEvent[]): Promise<VillageAssistantReply> {
  const response = await apiRequest<VillageReply>('/api/v1/village/assistant/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question,
      device_id: snapshot.source === 'MOCK' ? 'arduino-sim-01' : 'arduino-village',
      source: snapshot.source,
      captured_at: new Date().toISOString(),
      evidence: buildVillageEvidence(snapshot, events),
    }),
  }, 45_000)
  return { text: response.answer, mode: response.answer_mode === 'llm' ? 'llm' : 'server_rules', model: response.llm_model, fallbackReason: response.fallback_reason, evidence: response.evidence, status: response.status }
}

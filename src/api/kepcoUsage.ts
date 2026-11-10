import { apiRequest } from '../lib/backend'

export interface KepcoUsageRecord {
  period: string
  region: string
  district: string
  contract_type: string
  sales_amount: string
}

export interface KepcoUsagePage {
  total_count: number
  records: KepcoUsageRecord[]
}

export function getKepcoUsagePage(page: number, perPage = 1000): Promise<KepcoUsagePage> {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer')
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 1000) throw new RangeError('perPage must be between 1 and 1000')
  const query = new URLSearchParams({ page: String(page), per_page: String(perPage) })
  return apiRequest(`/api/v1/energy/kepco/usage?${query}`)
}

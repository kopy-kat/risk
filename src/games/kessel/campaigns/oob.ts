import type { PlayerId } from '../../../engine/types'
import type { ProvinceId } from '../map'

export const inf = (side: PlayerId, at: ProvinceId, strength?: number) => ({ side, type: 'infantry' as const, at, strength })
export const arm = (side: PlayerId, at: ProvinceId) => ({ side, type: 'armour' as const, at })
export const rec = (side: PlayerId, at: ProvinceId) => ({ side, type: 'recon' as const, at })

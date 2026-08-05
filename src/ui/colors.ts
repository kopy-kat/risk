/** Six seat colours, matching --p1..--p6 in theme.css. */
export const playerColor = (i: number) => `var(--p${(i % 6) + 1})`

export const PALETTE_NAMES = ['Crimson', 'Azure', 'Amber', 'Violet', 'Jade', 'Rose']

export const SUIT_GLYPH: Record<string, string> = {
  infantry: '★',
  cavalry: '⬟',
  artillery: '⬢',
  wild: '✦',
}

const colorPalette = [
  '#FF6B6B', // Red
  '#6B8EFF', // Blue
  '#6BFF8E', // Green
  '#FFD16B', // Yellow
  '#FF6BEB', // Pink
  '#6BFFEB', // Cyan
  '#FFB86B', // Orange
  '#BE6BFF' // Purple
]

export function getUserColor(userId: string): string {
  // Simple hash function to get a deterministic index
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % colorPalette.length
  return colorPalette[index]
}

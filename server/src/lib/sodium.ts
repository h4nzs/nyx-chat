import sodium from 'libsodium-wrappers'

let sodiumInstance: typeof sodium | null = null

export async function getSodium (): Promise<typeof sodium> {
  if (sodiumInstance) {
    return sodiumInstance
  }
  await sodium.ready
  sodiumInstance = sodium
  return sodium
}

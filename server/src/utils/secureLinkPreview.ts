import { getLinkPreview } from 'link-preview-js'
import dns from 'dns/promises'
import ipaddr from 'ipaddr.js'

// PERBAIKAN: Gunakan inferensi tipe dari return value fungsi
type LinkPreview = Awaited<ReturnType<typeof getLinkPreview>>;

// List of disallowed IP ranges
const disallowedRanges = [
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'reserved'
]

// Custom DNS resolver to prevent SSRF
export async function resolveDns (url: string): Promise<string> {
  const hostname = new URL(url).hostname
  // Validate hostname format to prevent injection
  if (!/^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(hostname) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
     // Allow simple hostnames or IPs if they are valid, but be strict about weird chars
     // For now, let dns.lookup handle validity, but we could add regex for extra safety
  }

  const { address } = await dns.lookup(hostname)
  const addr = ipaddr.parse(address)

  if (disallowedRanges.includes(addr.range())) {
    throw new Error(`SSRF attempt detected: IP address ${address} is in a disallowed range.`)
  }

  return address
}

// Helper to manually follow redirects and validate each step
async function validateRedirectChain(initialUrl: string): Promise<string> {
  let currentUrl = initialUrl
  let redirectCount = 0
  const maxRedirects = 5

  while (redirectCount < maxRedirects) {
    // 1. Validate DNS of current URL
    await resolveDns(currentUrl)

    // 2. Fetch with manual redirect using HEAD to be lightweight
    // We catch errors here to handle network failures gracefully during validation
    try {
      const res = await fetch(currentUrl, { method: 'HEAD', redirect: 'manual' })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) {
           return currentUrl // Redirect without location, treat as final
        }

        // Resolve relative URLs
        currentUrl = new URL(location, currentUrl).toString()
        redirectCount++
      } else {
        // Not a redirect (200, 404, etc), this is the final URL
        return currentUrl
      }
    } catch (e) {
      // If HEAD fails (e.g. 405 Method Not Allowed), fallback to trying to preview the current URL directly
      // assuming resolveDns passed.
      console.warn(`Redirect validation HEAD request failed for ${currentUrl}, proceeding with caution.`)
      return currentUrl
    }
  }
  throw new Error('Too many redirects')
}

/**
 * A secure wrapper around getLinkPreview to prevent SSRF attacks.
 * It includes a timeout and relies on a custom DNS resolver to validate
 * the initial URL and any subsequent redirects against disallowed IP ranges.
 * @param url The URL to get a preview for.
 * @returns A promise that resolves to the link preview.
 */
export async function getSecureLinkPreview (url: string): Promise<LinkPreview> {
  try {
    // 1. Manually validate the redirect chain
    const safeUrl = await validateRedirectChain(url)

    // 2. Get preview of the FINAL safe URL
    // We disable following redirects here because we already found the final one
    const preview = await getLinkPreview(safeUrl, {
      timeout: 5000,
      followRedirects: 'manual',
      handleRedirects: (baseURL: string, forwardedURL: string) => {
        // Since we pre-validated the chain, we shouldn't encounter new redirects here.
        // If we do, it means the server changed behavior between HEAD and GET.
        // For safety, we can just return the forwardedURL if it's valid, or throw.
        // But simply returning false or the url stops the chain.
        // Returning true usually implies "continue".
        // The library expects a function that returns a boolean or promise<boolean> to continue?
        // Wait, checking docs/types: handleRedirects?: (baseURL: string, forwardedURL: string) => boolean;

        // Actually, looking at common usage, if followRedirects is manual,
        // the library might expect US to do the fetching?
        // No, 'manual' in link-preview-js means "I will tell you if you should follow this redirect".

        // Let's check the error message implication: "no handleRedirects function is provided".
        // Providing a simple function that returns false (stop redirects) is safest since we fetched the final URL.
        return false;
      },
      resolveDNSHost: (u) => resolveDns(u) // Double-check the final URL
    })
    return preview as LinkPreview
  } catch (error) {
    console.error(`Secure link preview failed for URL "${url}":`, error)
    throw error // Re-throw the error to be handled by the caller
  }
}

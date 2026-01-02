import { getLinkPreview, type LinkPreview } from "link-preview-js";
import dns from 'dns/promises';
import ipaddr from 'ipaddr.js';

// List of disallowed IP ranges
const disallowedRanges = [
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "private",
  "reserved"
];

// Custom DNS resolver to prevent SSRF. This is called for the initial URL
// and for each subsequent redirect, providing security at each step.
async function resolveDns(url: string): Promise<string> {
  const hostname = new URL(url).hostname;
  const { address } = await dns.lookup(hostname);
  const addr = ipaddr.parse(address);

  if (disallowedRanges.includes(addr.range())) {
    throw new Error(`SSRF attempt detected: IP address ${address} is in a disallowed range.`);
  }

  return address;
}

/**
 * A secure wrapper around getLinkPreview to prevent SSRF attacks.
 * It includes a timeout and relies on a custom DNS resolver to validate
 * the initial URL and any subsequent redirects against disallowed IP ranges.
 * @param url The URL to get a preview for.
 * @returns A promise that resolves to the link preview.
 */
export async function getSecureLinkPreview(url: string): Promise<LinkPreview> {
  try {
    const preview = await getLinkPreview(url, {
      timeout: 5000,
      followRedirects: 'follow', // Let the library handle redirects
      resolveDNSHost: (url) => resolveDns(url), // Our security check is here
    });
    return preview as LinkPreview;
  } catch (error) {
    console.error(`Secure link preview failed for URL "${url}":`, error);
    throw error; // Re-throw the error to be handled by the caller
  }
}
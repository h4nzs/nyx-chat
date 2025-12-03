import { getLinkPreview, LinkPreview } from "link-preview-js";
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

// Custom DNS resolver to prevent SSRF
async function resolveDns(url: string): Promise<string> {
  const hostname = new URL(url).hostname;
  const { address } = await dns.lookup(hostname);
  const addr = ipaddr.parse(address);

  if (disallowedRanges.includes(addr.range())) {
    throw new Error(`SSRF attempt detected: IP address ${address} is in a disallowed range.`);
  }

  return address;
}

// Custom redirect handler to prevent SSRF on redirects
function handleRedirects(url: string, newUrl: string, maxRedirects: number): Promise<boolean> {
  return new Promise(async (resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error("Exceeded max redirects."));
    }
    try {
      await resolveDns(newUrl); // Validate the new URL's IP
      resolve(true); // Allow the redirect
    } catch (error) {
      reject(error); // Reject if the redirect target is disallowed
    }
  });
}

/**
 * A secure wrapper around getLinkPreview to prevent SSRF attacks.
 * It includes a timeout, DNS resolution checks, and redirect validation.
 * @param url The URL to get a preview for.
 * @returns A promise that resolves to the link preview.
 */
export async function getSecureLinkPreview(url: string): Promise<LinkPreview> {
  try {
    const preview = await getLinkPreview(url, {
      timeout: 5000,
      followRedirects: `manual`,
      handleRedirects: (baseURL, forwardURL, maxRedirects) => handleRedirects(baseURL, forwardURL, maxRedirects),
      resolveDNS: (url) => resolveDns(url),
    });
    return preview as LinkPreview;
  } catch (error) {
    console.error(`Secure link preview failed for URL "${url}":`, error);
    throw error; // Re-throw the error to be handled by the caller
  }
}

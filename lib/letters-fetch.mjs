// One document, fetched once, under every limit that matters.
//
// The rules are the point of this module, so each is enforced while the body
// is still arriving rather than after it has landed: a redirect that leaves
// sec.gov is refused, a body that passes the cap is abandoned mid-stream, and
// the hash is computed as the bytes go by so nothing is ever read twice. A
// 403 or a 429 stops the run outright and is never retried: those are the SEC
// asking us to stop, and the answer is to stop.
//
// `fetchImpl` is injectable so the tests can drive every refusal without a
// network, which is the only way to test a redirect to a hostile host.

import { createHash } from 'node:crypto';

export const CAP_BYTES = 15 * 1024 * 1024; // 15 MiB exactly, 15,728,640 bytes
export const MAX_REDIRECTS = 3;
const SEC_HOST = /(^|\.)sec\.gov$/i;

export class FetchRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.stopRun = code === 'forbidden' || code === 'rate_limited';
  }
}

export const isSecUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SEC_HOST.test(u.hostname);
  } catch {
    return false;
  }
};

/** What a document of this kind should come back as. */
export function contentTypeMatches(expectedFormat, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (expectedFormat === 'pdf') return ct.includes('application/pdf');
  if (expectedFormat === 'html' || expectedFormat === 'inline_html') return ct.includes('text/html') || ct.includes('application/xhtml');
  if (expectedFormat === 'text') return ct.includes('text/plain');
  return false;
}

/**
 * Fetch one approved document. Returns the bytes, the hash and what the
 * server said; throws a FetchRefusal naming which rule stopped it.
 */
export async function fetchDocument({
  url,
  expectedFormat,
  expectedBytes = null,
  cap = CAP_BYTES,
  userAgent,
  fetchImpl = fetch,
  maxRedirects = MAX_REDIRECTS,
  onAttempt = () => {},
}) {
  if (!isSecUrl(url)) throw new FetchRefusal('not_sec', `${url} is not an https sec.gov URL`);

  let current = url;
  let res = null;
  const redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    res = await fetchImpl(current, {
      headers: { 'User-Agent': userAgent, Accept: expectedFormat === 'pdf' ? 'application/pdf' : 'text/html' },
      redirect: 'manual',
    });
    onAttempt({ url: current, status: res.status, hop });
    if (res.status === 403) throw new FetchRefusal('forbidden', `HTTP 403 for ${current}; stopping the run without a retry`);
    if (res.status === 429) throw new FetchRefusal('rate_limited', `HTTP 429 for ${current}; stopping the run without a retry`);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new FetchRefusal('bad_redirect', `HTTP ${res.status} for ${current} with no Location`);
      const next = new URL(location, current).toString();
      if (!isSecUrl(next)) throw new FetchRefusal('offsite_redirect', `${current} redirected to ${next}, which is not sec.gov`);
      redirects.push({ from: current, to: next, status: res.status });
      current = next;
      continue;
    }
    break;
  }
  if (res.status >= 300 && res.status < 400) throw new FetchRefusal('too_many_redirects', `more than ${maxRedirects} redirects from ${url}`);
  if (!res.ok) throw new FetchRefusal('http_error', `HTTP ${res.status} for ${current}`);

  const contentType = res.headers.get('content-type');
  // The SEC serves these compressed and fetch decodes them on the way in, so
  // Content-Length describes the bytes on the wire, not the document. The
  // comparison below is only meaningful when nothing was encoded.
  const encoding = (res.headers.get('content-encoding') || '').toLowerCase();
  const decoded = encoding && encoding !== 'identity';
  if (!contentTypeMatches(expectedFormat, contentType)) {
    throw new FetchRefusal('wrong_type', `expected ${expectedFormat} but the server sent ${contentType || 'no content type'}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new FetchRefusal('declared_too_large', `Content-Length ${declared} is over the ${cap} byte cap`);
  }

  const hash = createHash('sha256');
  const chunks = [];
  let bytes = 0;
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > cap) {
      await reader.cancel().catch(() => {});
      throw new FetchRefusal('body_too_large', `the body passed the ${cap} byte cap after ${bytes} bytes`);
    }
    hash.update(value);
    chunks.push(value);
  }

  const warnings = [];
  if (!decoded && Number.isFinite(declared) && declared > 0 && declared !== bytes) {
    warnings.push(`Content-Length said ${declared} but ${bytes} bytes arrived`);
  }
  if (expectedBytes !== null && expectedBytes !== bytes) warnings.push(`the selection recorded ${expectedBytes} bytes but ${bytes} arrived; the filing may have been amended`);

  return {
    finalUrl: current,
    redirects,
    status: res.status,
    contentType,
    declaredBytes: Number.isFinite(declared) ? declared : null,
    contentEncoding: encoding || null,
    bytes,
    sha256: hash.digest('hex'),
    body: Buffer.concat(chunks),
    warnings,
  };
}

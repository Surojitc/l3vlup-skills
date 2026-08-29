/**
 * Read the fields the Workday LIST endpoint does not return.
 *
 * The list call gives title, externalPath, a locationsText string that is often
 * just "3 Locations", and postedOn as relative prose ("Posted Yesterday"). The
 * per-job DETAIL call, at the same site path plus externalPath, returns the
 * facts underneath. Confirmed live against Mastercard's board:
 *
 *   startDate               "2026-08-28"
 *   endDate                 "2026-09-30"
 *   jobRequisitionLocation  { descriptor, country: { descriptor, alpha2Code } }
 *   timeType                "Full time"
 *
 * endDate is the apply-by date, not an internal marker: Workday renders it to
 * candidates as "time left to apply", and returns jobPostingEndDateAsText
 * alongside it. That single field is the largest available source of deadlines
 * for banks, which are almost all on Workday and almost all currently undated.
 */

/** Detail URL. externalPath already starts with '/job/', so nothing goes between. */
export function detailUrl(host, tenant, site, externalPath) {
  if (!host || !tenant || !site || !externalPath) return null;
  return `https://${host}/wday/cxs/${tenant}/${site}${externalPath}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date is only useful if it is plausible. The same guard the prose extractor
 * uses: nothing in the past, nothing implausibly far out. A requisition left
 * open with a placeholder end date years away is not a deadline anybody should
 * see counting down.
 */
export function plausibleDeadline(value, { now = new Date(), maxMonths = 24 } = {}) {
  if (typeof value !== 'string') return undefined;
  const date = value.slice(0, 10);
  if (!ISO.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  if (d < today) return undefined;
  const ceiling = new Date(today);
  ceiling.setUTCMonth(ceiling.getUTCMonth() + maxMonths);
  if (d > ceiling) return undefined;
  return date;
}

/** A posting date must be a real past date; a future one is bad data. */
export function plausiblePostedDate(value, { now = new Date() } = {}) {
  if (typeof value !== 'string') return undefined;
  const date = value.slice(0, 10);
  if (!ISO.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return undefined;
  return date;
}

/**
 * Normalise one detail payload. Returns only fields that survived validation,
 * so a caller can spread it over an existing role without erasing good data
 * with undefined.
 */
export function parseWorkdayDetail(payload, opts = {}) {
  const info = payload?.jobPostingInfo;
  if (!info) return {};

  const out = {};
  const closing = plausibleDeadline(info.endDate, opts);
  if (closing) out.closingDate = closing;
  const posted = plausiblePostedDate(info.startDate, opts);
  if (posted) out.openingDate = posted;

  // The structured location beats locationsText, which is frequently the
  // useless "3 Locations" rather than a place.
  const loc = info.jobRequisitionLocation;
  const descriptor = loc?.descriptor ?? info.location;
  if (typeof descriptor === 'string' && descriptor.trim()) out.location = descriptor.trim();
  const alpha2 = loc?.country?.alpha2Code ?? info.country?.alpha2Code;
  if (typeof alpha2 === 'string' && /^[A-Z]{2}$/.test(alpha2)) out.countryCode = alpha2;
  if (typeof info.timeType === 'string' && info.timeType.trim()) out.timeType = info.timeType.trim();

  return out;
}

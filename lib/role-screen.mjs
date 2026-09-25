/**
 * Records on a careers board that are not roles.
 *
 * WHY THIS EXISTS
 * ---------------
 * An ATS is a list of everything a recruiting team wanted a candidate to click,
 * and not all of it is a job. CIBC publishes its Private Wealth information
 * session as a Workday requisition; IMC publishes an invitation-only London
 * networking evening on the same Greenhouse board as its internships. Both
 * pass the early-career filter, because both say "Rotational Program" or
 * "Campus" in the title, and both became indexable programme pages on the
 * site. An external SEO audit found them there.
 *
 * A second kind of noise is not a non-role at all but a real role with a junk
 * title. Citi's India apprenticeship arrives as "Job Requisition: 25843173 Citi
 * India Apprenticeship Program - SS Ops": the requisition label is an artefact
 * of how the posting was keyed into Workday, and everything after it is the
 * programme. Dropping that row would delete a real seat; cleaning the title
 * keeps the seat and loses the artefact.
 *
 * PRECISION OVER RECALL
 * ---------------------
 * A false positive here silently deletes a real role from the tracker, and
 * nobody would notice, because the row simply stops arriving. A false negative
 * leaves a page up that should not be there, which is what already happens.
 * So every rule is a phrase, not a word, and every drop rule has guards:
 *
 *   - "event" alone is never enough. BlackRock's "Spring Insight Event" is a
 *     selective programme a candidate applies to, and Snowflake's "Strategic
 *     Events Intern" is a job about events. Only phrases that name a session a
 *     person attends rather than a seat they fill are matched: information
 *     session, webinar, open day, networking event, meet the team.
 *   - a title that also names a person in a seat (intern, trainee, engineer,
 *     coordinator, producer and so on) is kept even when it contains one of
 *     those phrases, because "Webinar Producer Intern" is a job. A programme
 *     word (analyst, internship, programme) protects the title only when it
 *     follows the session phrase: "Summer Analyst Program - Information
 *     Session" is a session about a programme, "Information Session Programme
 *     Associate" is left alone.
 *   - insight programmes, spring weeks and taster days are never dropped. They
 *     are the first rung of a banking recruiting cycle and the site lists them
 *     on purpose, even though they look like events.
 *
 * Talent communities and "future opportunities" pools (IMC's "2027 EU Campus
 * Programme Talent Community", Gusto's "Future Opportunities: Early Career
 * Sales Talent") are deliberately NOT dropped. They are an application route a
 * candidate can act on, and the case for removing them is a product decision,
 * not an obvious-noise one. See docs/role-lifecycle-telemetry-2026-09.md.
 *
 * WHAT HAPPENS TO A DROPPED ROW'S URL
 * -----------------------------------
 * The slug registry is untouched: the slug stays reserved to its record for
 * ever, so no future role can be issued it. The archive entry is removed (see
 * `isNonRoleTitle` in scripts/sync-ats.mjs's updateArchive), so the site stops
 * resolving the URL and answers 404, rather than rendering an information
 * session as an "archived role" that stays indexable for ninety days. For a
 * page that was never a job, not found is the true answer.
 */

import { normaliseText } from './text-normalise.mjs';

/**
 * Phrases naming something a candidate attends rather than a seat they fill.
 * Each is a phrase, so none fires on the word "event" or "session" alone.
 */
const ATTENDANCE =
  /\b(info(?:rmation)?\s+sessions?|webinars?|open\s+(?:days?|house|evenings?)|networking\s+(?:events?|evenings?|sessions?|nights?|receptions?|dinners?)|recruit(?:ing|ment)\s+(?:events?|sessions?)|meet\s+(?:the|our)\s+(?:teams?|recruiters?|firm)|meet\s*(?:&|and)\s*greets?|coffee\s+chats?|careers?\s+fairs?)\b/i;

const ATTENDANCE_ALL = new RegExp(ATTENDANCE.source, 'gi');

/**
 * A title that names a person in a seat is a job, whatever else it mentions:
 * "Webinar Producer Intern", "Intern - Webinar Operations", "Open Day
 * Coordinator".
 */
const PERSON =
  /\b(intern|interns|trainee|trainees|apprentice|apprentices|engineer|developer|coordinator|specialist|assistant|producer|officer|representative|consultant|researcher|scientist|co-?op)\b/i;

/**
 * Words that name a programme rather than a person. They appear in the title
 * of the session about the programme as readily as in the programme itself
 * ("Summer Analyst Program - Information Session"), so they only protect a
 * title when the session phrase comes first and the programme is the head of
 * the title, which in English is its last noun.
 */
const PROGRAMME =
  /\b(internships?|apprenticeships?|analysts?|associates?|placements?|programmes?|programs?|schemes?)\b/gi;

/** First-rung programmes that look like events and are not noise. */
const INSIGHT = /\b(insight|spring\s+weeks?|spring\s+programmes?|spring\s+internships?|discovery\s+(?:days?|programmes?|weeks?)|taster)\b/i;

/**
 * A requisition label at the front of a title: "Job Requisition: 25843173",
 * "Requisition ID 12345 -", "Req #R12345". Labelled forms only. A bare leading
 * number is not matched, because "10,000 Black Interns" is a real programme.
 */
const LEADING_REQUISITION =
  /^\s*(?:job\s+)?(?:requisition|req)(?:\s*(?:id|no\.?|number|#))?\s*[:#.-]?\s*[A-Z]{0,4}[-_]?\d{4,}[A-Z0-9-]*\s*[-–—:|]*\s*/i;

/** The same label at the end: "... (Req ID: 12345)", "... - Requisition 12345". */
const TRAILING_REQUISITION =
  /\s*(?:[-–—|:]\s*|\(\s*)(?:job\s+)?(?:requisition|req)(?:\s*(?:id|no\.?|number|#))?\s*[:#.-]?\s*[A-Z]{0,4}[-_]?\d{4,}[A-Z0-9-]*\s*\)?\s*$/i;

/** Postings that say in their own title that they are not real. */
const PLACEHOLDER = /\bdo\s+not\s+(?:apply|use|post)\b|^\s*(?:test|dummy)\s+(?:job|posting|requisition|req)\b/i;

/**
 * The title with any requisition label removed, or the title unchanged.
 *
 * Only removes; never rewrites what is left, so the programme name the
 * employer chose is the one that survives.
 */
export function cleanRoleTitle(title) {
  const text = normaliseText(title);
  const cleaned = text.replace(LEADING_REQUISITION, '').replace(TRAILING_REQUISITION, '').trim();
  return cleaned === text ? text : cleaned;
}

/**
 * Why a title is not a role, or null when it is one.
 *
 *   'attendance'  an information session, webinar, open day, networking event
 *   'placeholder' nothing but a requisition label, or a self-declared test post
 */
export function nonRoleReason(title) {
  const text = normaliseText(title);
  if (!text) return null;

  if (PLACEHOLDER.test(text)) return 'placeholder';
  const rest = cleanRoleTitle(text);
  if (rest !== text && !/[a-z]{3,}/i.test(rest)) return 'placeholder';

  const sessions = [...text.matchAll(ATTENDANCE_ALL)];
  if (!sessions.length || PERSON.test(text) || INSIGHT.test(text)) return null;
  // The session is the head of the title when no programme word follows its
  // last mention.
  const session = sessions[sessions.length - 1];
  const programmeAfter = [...text.matchAll(PROGRAMME)].some((m) => m.index > session.index);
  return programmeAfter ? null : 'attendance';
}

/** True when a title is not a role. For the archive, which holds titles only. */
export function isNonRoleTitle(title) {
  return nonRoleReason(title) !== null;
}

/**
 * Split a day's rows into roles and non-roles, cleaning titles on the way.
 *
 * Pure: the input rows are not mutated. A cleaned row is a copy with the new
 * `role`; its id, and therefore its slug, is unchanged, because the registry
 * is keyed by id and a record keeps its URL when its title changes.
 */
export function screenRoles(rows) {
  const kept = [];
  const dropped = [];
  const cleaned = [];
  for (const row of rows ?? []) {
    const reason = nonRoleReason(row?.role);
    if (reason) {
      dropped.push({ row, reason });
      continue;
    }
    const role = cleanRoleTitle(row?.role);
    if (role && role !== normaliseText(row?.role)) {
      cleaned.push({ row, from: row.role, to: role });
      kept.push({ ...row, role });
    } else {
      kept.push(row);
    }
  }
  return { kept, dropped, cleaned };
}

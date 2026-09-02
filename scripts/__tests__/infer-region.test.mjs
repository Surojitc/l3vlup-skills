/**
 * Region inference, and the 293 rows it was getting wrong in silence.
 *
 * The old version tested five short patterns and returned 'US' for anything
 * else. That default is unavoidable — the taxonomy has no "unknown" and a row
 * has to render somewhere — but nothing counted how often it fired, so nobody
 * saw that 293 of 577 US rows carried a location saying nothing US-like.
 * Bristol was on the US hub. Taipei, Aarhus, Helsinki and Budapest were too.
 */
import { inferRegion, unmatchedLocations } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   got ${got} want ${want}`}`);
  ok ? pass++ : fail++;
};

// --- the ones that were landing in the wrong place ---
eq('Bristol is UK', inferRegion('Bristol'), 'UK');
eq('a UK city with no country is still UK', inferRegion('Leeds'), 'UK');
eq('Taiwan is Asia', inferRegion('Taiwan, Taipei'), 'Asia');
eq('Denmark is Europe', inferRegion('Aarhus, Central Denmark Region, Denmark'), 'Europe');
eq('Hungary is Europe', inferRegion('Hungary, Budapest'), 'Europe');
eq('the French spelling of Brussels is Europe', inferRegion('Bruxelles Avenue Marnix (ING)'), 'Europe');
eq('a bare "Europe" is Europe', inferRegion('Europe'), 'Europe');

// --- the ones that were already right and must stay right ---
eq('London is UK', inferRegion('London, United Kingdom'), 'UK');
eq('New York is US', inferRegion('New York, NY'), 'US');
eq('Singapore is Asia', inferRegion('Singapore'), 'Asia');
eq('Dubai is Middle East', inferRegion('Dubai'), 'Middle East');
eq('remote beats everything', inferRegion('Remote - US'), 'Remote');

// --- state codes, which need the comma to be safe ---
eq('a state code after a comma is US', inferRegion('Greenwich, CT'), 'US');
eq('and another', inferRegion('Malvern, PA'), 'US');
// "MA - Casablanca, Morocco" must not become US off a bare "MA", and India must
// not match "\bin\b". These are the reason the codes require a leading comma.
eq('a bare state code in prose does not match', inferRegion('MA - Casablanca, Morocco'), 'US');
eq('Bengaluru is Asia, not US via "in"', inferRegion('Bengaluru, India'), 'Asia');
eq('Ontario is not matched as "on"', inferRegion('Toronto'), 'US');

// --- the default is a guess, and it has to be counted ---
{
  unmatchedLocations.clear();
  eq('an unplaceable string still returns a region', inferRegion('2 Locations'), 'US');
  eq('and is recorded', unmatchedLocations.get('2 Locations'), 1);
  inferRegion('2 Locations');
  eq('counting the second sighting', unmatchedLocations.get('2 Locations'), 2);
  inferRegion('London');
  eq('a placed location is not recorded', unmatchedLocations.size, 1);
  eq('a blank location is recorded under a readable key', (inferRegion(''), unmatchedLocations.has('(blank)')), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * Region inference, and the 293 rows it was getting wrong in silence.
 *
 * The old version tested five short patterns and returned 'US' for anything
 * else. That default is unavoidable — the taxonomy has no "unknown" and a row
 * has to render somewhere — but nothing counted how often it fired, so nobody
 * saw that 293 of 577 US rows carried a location saying nothing US-like.
 * Bristol was on the US hub. Taipei, Aarhus, Helsinki and Budapest were too.
 */
import { inferRegion, unmatchedLocations, regionForCountry, withCountry } from '../sync-ats.mjs';

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
// Toronto was US until 27 November 2026, when Canada became a region.
eq('Toronto is Canada', inferRegion('Toronto'), 'Canada');

// --- substring collisions, all of which shipped in the first version ---

// `india` matched Indianapolis, `wales` matched New South Wales, and `oman`
// matched Romania. Each was found by reading the diff rather than by a failing
// test, which is why they are pinned here.
eq('Indianapolis is not India', inferRegion('Indianapolis, IN'), 'US');
eq('nor is Indiana', inferRegion('Bloomington, Indiana'), 'US');
eq('New South Wales is not Wales', inferRegion('Sydney, New South Wales'), 'Asia');
eq('and neither is the state on its own', inferRegion('New South Wales, Australia'), 'Asia');
eq('Romania is not Oman', inferRegion('Bucharest, Romania'), 'Europe');
eq('Oman still is', inferRegion('Oman'), 'Middle East');

// --- cities that exist in both countries ---

// A state code is the stronger signal, so it is tested before the bare UK
// names. With nothing attached, the larger city wins.
eq('Birmingham with a state code is US', inferRegion('Birmingham, AL'), 'US');
eq('Birmingham on its own is UK', inferRegion('Birmingham'), 'UK');
eq('Manchester with a state code is US', inferRegion('Manchester, NH'), 'US');
eq('Cambridge with a state code is US', inferRegion('Cambridge, MA'), 'US');
// A European city must never reach the state-code rule: DE is Delaware.
eq('Munich is Europe, not Delaware', inferRegion('Munich, DE'), 'Europe');
// L.E.K.'s Wroclaw office was published as US (25 November 2026): Poland was
// known by its two largest cities only.
eq('Wroclaw is Europe', inferRegion('Wroclaw'), 'Europe');
eq('Wrocław with its diacritic is Europe', inferRegion('Wrocław, Poland'), 'Europe');
eq('Gdansk is Europe', inferRegion('Gdansk'), 'Europe');
eq('Kyiv is Europe', inferRegion('Kyiv, , Ukraine'), 'Europe');

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

// Workday's detail states the country as a code; that beats a bare city.
eq('IT is Europe', regionForCountry('IT'), 'Europe');
eq('GB is UK', regionForCountry('GB'), 'UK');
eq('AE is Middle East', regionForCountry('AE'), 'Middle East');
eq('SG is Asia', regionForCountry('SG'), 'Asia');
eq('US is US', regionForCountry('US'), 'US');
eq('Canada is its own region', regionForCountry('CA'), 'Canada');
eq('Brazil is Latin America', regionForCountry('BR'), 'Latin America');
eq('Mexico is Latin America', regionForCountry('MX'), 'Latin America');
eq('no code is null', regionForCountry(undefined), null);
eq('a bare city gains its country', withCountry('Milan', 'IT'), 'Milan, Italy');
eq('a named country is not repeated', withCountry('London, United Kingdom', 'GB'), 'London, United Kingdom');
eq('no code leaves the text alone', withCountry('Milan', undefined), 'Milan');


// Canada and Latin America (27 November 2026). The rows below are the forms
// they took on the published feed, all of them filed as US before.
for (const loc of ['Montreal', 'Toronto, Canada', 'Toronto, ON, CAN', 'Toronto, Ontario', 'Toronto, ON, Canada', 'Mississauga Ontario Canada', 'Toronto, Bay Wellington Tower L47', 'Vancouver, BC', 'Calgary, AB', 'Montréal, QC, Canada']) {
  eq(`${loc} is Canada`, inferRegion(loc), 'Canada');
}
for (const loc of ['Mexico', 'Mexico City, Mexico', 'Sao Paulo Sao Paulo Brazil', 'São Paulo, São Paulo, Brazil', 'Argentina', 'Costa Rica, San Jose', 'Bogota Colombia', 'Santiago, Chile', 'Lima, Peru']) {
  eq(`${loc} is Latin America`, inferRegion(loc), 'Latin America');
}
// Neighbours that must not move.
eq('New Mexico stays US', inferRegion('Albuquerque, New Mexico'), 'US');
eq('Santa Fe, NM stays US', inferRegion('Santa Fe, NM'), 'US');
eq('San Jose, CA stays US (Costa Rica is named when meant)', inferRegion('San Jose, CA'), 'US');
eq('Ontario, CA (California) stays US', inferRegion('Ontario, CA'), 'US');
eq('Washington, D.C. stays US', inferRegion('Washington, D.C.'), 'US');
eq('Indianapolis is still not Naples', inferRegion('Indianapolis, IN'), 'US');
eq('"America" in a firm or desk name is still US', inferRegion('Bank of America Tower, New York'), 'US');
// Places the US default used to take.
eq('Knutsford (Barclays, Radbroke Hall) is UK', inferRegion('Knutsford, Radbroke Hall'), 'UK');
eq('Northampton (Barclays campus) is UK', inferRegion('Northampton, Barclays Campus, Pavilion Drive'), 'UK');
eq('Pisa is Europe', inferRegion('Pisa'), 'Europe');
eq('Putrajaya is Asia', inferRegion('PERSIARAN IRC 2, IOI RESORT CITY IOI CITY TOWER ONE:PUTRAJAYA'), 'Asia');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

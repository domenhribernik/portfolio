/* DOM-free edition builder for the views/projects broadsheet, the page
   that carries every project in components/project-data.js. Tested by
   tests/projects-edition-logic.test.mjs. */

/* A section may pin a presentation lead: that registry key is hoisted to
   the front of the section (and gets the section's photo treatment)
   regardless of registry order. The tests check the key still exists. */
export const SECTIONS = [
  { letter: 'A', category: 'professional', label: 'Professional & Freelance' },
  { letter: 'B', category: 'passion', label: 'Passion Projects' },
  { letter: 'C', category: 'academic', label: 'Academic & Research', leadKey: 'thesis' },
];

/* The whole edition: every registry entry in its section, newest first
   (registry insertion order is oldest first), folios numbered from 1.
   Empty sections are omitted. */
export function buildEdition(registry) {
  const sections = SECTIONS
    .map(({ letter, category, label, leadKey }) => {
      const entries = Object.keys(registry)
        .filter(key => registry[key].category === category)
        .map(key => ({ key, ...registry[key] }))
        .reverse();
      const lead = leadKey ? entries.findIndex(e => e.key === leadKey) : -1;
      if (lead > 0) entries.unshift(...entries.splice(lead, 1));
      return {
        letter,
        label,
        entries: entries.map((entry, i) => ({ ...entry, folio: `${letter}${i + 1}` })),
      };
    })
    .filter(section => section.entries.length > 0);

  return { sections };
}

/* The site went to press in 2021; volumes count from that year. */
const FOUNDING_YEAR = 2021;

function roman(n) {
  const steps = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [value, glyph] of steps) {
    while (n >= value) { out += glyph; n -= value; }
  }
  return out;
}

/* Masthead dateline: volume in years since founding, edition number as
   the day of the year, plus the printed date and total story count. */
export function editionMeta(registry, date = new Date()) {
  /* UTC on both sides so the DST hour between January and now can't
     shave the count to one day short. */
  const day = (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    - Date.UTC(date.getFullYear(), 0, 1)) / 86400000 + 1;
  return {
    volume: `Vol. ${roman(date.getFullYear() - FOUNDING_YEAR + 1)}`,
    number: `No. ${day}`,
    count: Object.keys(registry).length,
    dateline: date.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }),
  };
}

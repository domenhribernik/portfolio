// Pure data + scoring logic for the Session Zero class oracle.
// No DOM access here; imported by script.js and tested via node --test.

export const CLASSES = {
  barbarian: {
    name: "Barbarian",
    epithet: "The Unstoppable",
    role: "Frontline bruiser",
    ability: "Strength",
    hitDie: "d12",
    complexity: 1,
    icon: "fa-hand-fist",
    blurb:
      "Rage is a resource, and you are very rich. Barbarians run straight at the scary thing, hit it with something enormous, and shrug off damage that would flatten anyone else.",
    goodIf: [
      "You want big, simple, decisive turns",
      "Being nearly impossible to kill sounds fun",
      "Your favorite solution is a well-placed axe",
    ],
    tip: "When in doubt: rage first, then attack the biggest thing on the table.",
  },
  bard: {
    name: "Bard",
    epithet: "The Silver Tongue",
    role: "Support and party face",
    ability: "Charisma",
    hitDie: "d8",
    complexity: 3,
    icon: "fa-guitar",
    blurb:
      "You fight with a song, a lie, and a suspiciously good plan. Bards make everyone around them better, and talk the party out of trouble as often as into it.",
    goodIf: [
      "You love roleplay and doing the talking",
      "Helping friends shine feels like winning",
      "You want a trick for every situation",
    ],
    tip: "Bardic Inspiration is meant to be spent. Hand it out early and often.",
  },
  cleric: {
    name: "Cleric",
    epithet: "The Divine Anchor",
    role: "Healer and support",
    ability: "Wisdom",
    hitDie: "d8",
    complexity: 2,
    icon: "fa-hands-praying",
    blurb:
      "The gods answer when you call, whether to knit wounds shut or bring down holy fire. Clerics keep the whole party alive and are far tougher than they look.",
    goodIf: [
      "You like being the reason nobody died",
      "You want good armor and good magic",
      "Playing the group's calm center appeals to you",
    ],
    tip: "Healing Word is a bonus action: pick a dying friend up and still do your turn.",
  },
  druid: {
    name: "Druid",
    epithet: "The Wild Shape",
    role: "Shapeshifter and caster",
    ability: "Wisdom",
    hitDie: "d8",
    complexity: 3,
    icon: "fa-paw",
    blurb:
      "The forest's answer to a wizard. Druids call lightning, command vines, heal with a touch, and, famously, turn into bears.",
    goodIf: [
      "Turning into animals sounds amazing (it is)",
      "You like nature, weather, and weird solutions",
      "You enjoy having many small tools to combine",
    ],
    tip: "Wild Shape is also your scout. Nobody suspects the spider on the wall.",
  },
  fighter: {
    name: "Fighter",
    epithet: "The Weapon Master",
    role: "Reliable damage and defense",
    ability: "Strength or Dexterity",
    hitDie: "d10",
    complexity: 1,
    icon: "fa-shield-halved",
    blurb:
      "Every legend, every army, every last stand has a fighter in it. Masters of all weapons and armor, with more attacks than anyone and a stubborn knack for staying alive.",
    goodIf: [
      "You want a sturdy, forgiving first character",
      "Consistency beats flashy tricks for you",
      "Any weapon fantasy works: knight, archer, duelist",
    ],
    tip: "Second Wind and Action Surge win fights. Don't hoard them for a perfect moment.",
  },
  monk: {
    name: "Monk",
    epithet: "The Flowing Fist",
    role: "Fast skirmisher",
    ability: "Dexterity",
    hitDie: "d8",
    complexity: 2,
    icon: "fa-yin-yang",
    blurb:
      "Speed as a martial art. Monks run up walls, catch arrows out of the air, and land a flurry of strikes before the enemy has finished drawing a sword.",
    goodIf: [
      "You want to be the fastest thing at the table",
      "Kung-fu film energy is your fantasy",
      "You like darting in and out of danger",
    ],
    tip: "You are fast on purpose. Hit, then move somewhere they can't answer.",
  },
  paladin: {
    name: "Paladin",
    epithet: "The Oathbound",
    role: "Holy knight",
    ability: "Strength and Charisma",
    hitDie: "d10",
    complexity: 2,
    icon: "fa-sun",
    blurb:
      "A knight with a promise, and the divine power to keep it. Paladins heal with a touch, hit like a thunderclap, and their very presence keeps friends brave.",
    goodIf: [
      "You want to be the shield between friends and danger",
      "A personal code or cause excites you",
      "You like mixing swordplay with a little magic",
    ],
    tip: "Save spell slots to Smite when you roll a critical hit. The table will lose its mind.",
  },
  ranger: {
    name: "Ranger",
    epithet: "The Hunter",
    role: "Scout and archer",
    ability: "Dexterity and Wisdom",
    hitDie: "d10",
    complexity: 2,
    icon: "fa-crosshairs",
    blurb:
      "At home where the map runs out. Rangers track anything, survive anywhere, and put arrows exactly where they need to go, often with an animal friend at their side.",
    goodIf: [
      "The wilderness is your favorite setting",
      "You like fighting from range",
      "Scouting ahead and knowing first sounds fun",
    ],
    tip: "Hunter's Mark first, then shoot. The extra damage adds up fast.",
  },
  rogue: {
    name: "Rogue",
    epithet: "The Shadow",
    role: "Precision striker and skill expert",
    ability: "Dexterity",
    hitDie: "d8",
    complexity: 1,
    icon: "fa-mask",
    blurb:
      "One perfect strike from the dark, then gone before anyone reacts. Outside of fights you are the lockpick, the scout, and the one who checks for traps.",
    goodIf: [
      "Sneaking and heists are your idea of fun",
      "You want to be good at many skills",
      "One huge hit beats many small ones for you",
    ],
    tip: "Sneak Attack works once per turn, so make it count. Hide, strike, repeat.",
  },
  sorcerer: {
    name: "Sorcerer",
    epithet: "The Born Flame",
    role: "Flexible blaster",
    ability: "Charisma",
    hitDie: "d6",
    complexity: 2,
    icon: "fa-fire",
    blurb:
      "You never studied magic. You simply are magic. Sorcerers bend and reshape their spells on the fly, twinning and quickening them in ways no wizard can.",
    goodIf: [
      "Raw magical talent beats homework for you",
      "You like bending rules with metamagic",
      "Charisma and chaos sound like a lifestyle",
    ],
    tip: "You know few spells, so every pick matters. Take Fireball at level five. It's tradition.",
  },
  warlock: {
    name: "Warlock",
    epithet: "The Pact Maker",
    role: "Steady magical damage",
    ability: "Charisma",
    hitDie: "d8",
    complexity: 2,
    icon: "fa-eye",
    blurb:
      "You made a deal with something ancient, and it delivers. Warlocks run on a short list of spells that hit like a truck and recharge on every breather.",
    goodIf: [
      "A mysterious patron is a story hook you love",
      "You want strong magic with simple upkeep",
      "A little spooky ambiguity suits you",
    ],
    tip: "Eldritch Blast is your bread and butter. Spend your two big slots freely, they return on a short rest.",
  },
  wizard: {
    name: "Wizard",
    epithet: "The Scholar",
    role: "Versatile spellcaster",
    ability: "Intelligence",
    hitDie: "d6",
    complexity: 3,
    icon: "fa-hat-wizard",
    blurb:
      "Magic as a science. Wizards trade hit points for the biggest spellbook in the game and an answer to nearly every problem, provided they prepared it this morning.",
    goodIf: [
      "You enjoy planning and preparation",
      "Having the right tool for anything is the dream",
      "You don't mind being fragile if you're brilliant",
    ],
    tip: "Stay in the back row. Your hit points are a rounding error.",
  },
};

export const QUESTIONS = [
  {
    id: "q1",
    prompt: "A dragon is terrorizing a village. Your first instinct?",
    answers: [
      {
        id: "q1a",
        text: "Walk up to it and hit it very, very hard.",
        weights: { barbarian: 3, fighter: 2 },
      },
      {
        id: "q1b",
        text: "Find its lair, learn its weakness, prepare the perfect counter.",
        weights: { wizard: 3, ranger: 2 },
      },
      {
        id: "q1c",
        text: "Rally the villagers. Nobody has to face this alone.",
        weights: { paladin: 2, bard: 2, cleric: 2 },
      },
      {
        id: "q1d",
        text: "Dragons hoard gold. I'm suddenly very motivated to help.",
        weights: { rogue: 3, warlock: 1 },
      },
    ],
  },
  {
    id: "q2",
    prompt: "Pick your ideal Friday night.",
    answers: [
      {
        id: "q2a",
        text: "Out with friends, center of every conversation.",
        weights: { bard: 3, sorcerer: 1 },
      },
      {
        id: "q2b",
        text: "A quiet evening and a genuinely fascinating book.",
        weights: { wizard: 3, cleric: 1 },
      },
      {
        id: "q2c",
        text: "Outside. Trail, campfire, stars.",
        weights: { ranger: 3, druid: 3 },
      },
      {
        id: "q2d",
        text: "Training hard, then eating an enormous meal.",
        weights: { barbarian: 2, fighter: 2, monk: 1 },
      },
    ],
  },
  {
    id: "q3",
    prompt: "In a group project, you're the one who...",
    answers: [
      {
        id: "q3a",
        text: "Keeps everyone organized and on track.",
        weights: { paladin: 2, cleric: 2, fighter: 1 },
      },
      {
        id: "q3b",
        text: "Pulls it off at 2am against all odds.",
        weights: { rogue: 2, sorcerer: 2, warlock: 1 },
      },
      {
        id: "q3c",
        text: "Suggests the wild idea nobody else would dare try.",
        weights: { sorcerer: 2, bard: 2, druid: 1 },
      },
      {
        id: "q3d",
        text: "Quietly does the best research in the group.",
        weights: { wizard: 2, monk: 1, ranger: 1 },
      },
    ],
  },
  {
    id: "q4",
    prompt: "How do you want to fight?",
    answers: [
      {
        id: "q4a",
        text: "Up close, huge weapon, maximum drama.",
        weights: { barbarian: 3, fighter: 2, paladin: 2 },
      },
      {
        id: "q4b",
        text: "Fast and precise, gone before they can react.",
        weights: { rogue: 3, monk: 3 },
      },
      {
        id: "q4c",
        text: "From a distance, ideally before they see me.",
        weights: { ranger: 3, warlock: 1 },
      },
      {
        id: "q4d",
        text: "I don't fight. I reshape the battlefield with magic.",
        weights: { wizard: 3, sorcerer: 2, druid: 2 },
      },
    ],
  },
  {
    id: "q5",
    prompt: "Your party is losing badly. What do you do?",
    answers: [
      {
        id: "q5a",
        text: "Put myself between the danger and my friends.",
        weights: { paladin: 3, fighter: 1, cleric: 1 },
      },
      {
        id: "q5b",
        text: "Get angry. Really, genuinely angry.",
        weights: { barbarian: 3 },
      },
      {
        id: "q5c",
        text: "Keep everyone standing. Nobody dies on my watch.",
        weights: { cleric: 3, druid: 2, bard: 1 },
      },
      {
        id: "q5d",
        text: "There is always a way out. I find it.",
        weights: { rogue: 2, warlock: 2, bard: 1 },
      },
    ],
  },
  {
    id: "q6",
    prompt: "Pick a source of power.",
    answers: [
      {
        id: "q6a",
        text: "Years of discipline and relentless training.",
        weights: { monk: 3, fighter: 2, ranger: 1 },
      },
      {
        id: "q6b",
        text: "Study. Knowledge is the sharpest blade.",
        weights: { wizard: 3 },
      },
      {
        id: "q6c",
        text: "Faith in something far bigger than me.",
        weights: { cleric: 3, paladin: 2 },
      },
      {
        id: "q6d",
        text: "A deal. Don't ask with whom.",
        weights: { warlock: 3, sorcerer: 1 },
      },
    ],
  },
  {
    id: "q7",
    prompt: "How many buttons do you want on your character?",
    answers: [
      {
        id: "q7a",
        text: "One big button. I press it extremely well.",
        weights: { barbarian: 2, fighter: 2, rogue: 1 },
      },
      {
        id: "q7b",
        text: "A few solid options I can truly master.",
        weights: { monk: 2, paladin: 2, ranger: 2, warlock: 2 },
      },
      {
        id: "q7c",
        text: "Give me the entire control panel.",
        weights: { wizard: 2, druid: 2, bard: 1, cleric: 1, sorcerer: 1 },
      },
    ],
  },
  {
    id: "q8",
    prompt: "Years later, what should your party say about you?",
    answers: [
      {
        id: "q8a",
        text: "\"They carried us through every single fight.\"",
        weights: { fighter: 2, barbarian: 2, paladin: 1 },
      },
      {
        id: "q8b",
        text: "\"They always had the clever solution.\"",
        weights: { wizard: 2, rogue: 2, bard: 1 },
      },
      {
        id: "q8c",
        text: "\"They kept the whole party alive.\"",
        weights: { cleric: 3, druid: 2 },
      },
      {
        id: "q8d",
        text: "\"Honestly? The chaos. We loved the chaos.\"",
        weights: { sorcerer: 3, warlock: 2, bard: 2 },
      },
    ],
  },
];

const ANSWER_INDEX = new Map();
for (const q of QUESTIONS) {
  for (const a of q.answers) ANSWER_INDEX.set(a.id, a);
}

// answerIds: array of answer id strings (e.g. ["q1a", "q2c", ...]).
// Returns every class ranked by score, descending. Ties break by
// registry order so results are deterministic. Unknown ids are ignored.
export function scoreQuiz(answerIds) {
  const order = Object.keys(CLASSES);
  const scores = Object.fromEntries(order.map((id) => [id, 0]));
  for (const answerId of answerIds || []) {
    const answer = ANSWER_INDEX.get(answerId);
    if (!answer) continue;
    for (const [classId, weight] of Object.entries(answer.weights)) {
      scores[classId] += weight;
    }
  }
  return order
    .map((id) => ({ id, score: scores[id] }))
    .sort((a, b) => b.score - a.score || order.indexOf(a.id) - order.indexOf(b.id));
}

// Convenience wrapper: the single recommended class plus two runners-up.
export function recommend(answerIds) {
  const ranked = scoreQuiz(answerIds);
  return { top: ranked[0].id, runnersUp: [ranked[1].id, ranked[2].id] };
}

// Roman numerals for the question counter (1..3999 is plenty here).
export function toRoman(n) {
  const table = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  let rest = n;
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

export const projects = {
  //? Professional Projects
  vitaMavric: {
    category: "professional",
    gradient: "linear-gradient(45deg, #f093fb 0%, #f5576c 100%)",
    title: "Vita Mavrič",
    description: "A handcrafted site for theater artist Vita Mavrič, featuring clean typography, considered layout, and zero dependencies. Built to let her work speak for itself.",
    links: {
      visitSite: "https://vitamavric.com",
    },
    iconClass: "fas fa-masks-theater",
  },
  gasperStrazisar: {
    category: "professional",
    gradient: "linear-gradient(45deg, #4facfe 0%, #00f2fe 100%)",
    title: "Gašper Stražišar",
    description: "A clean editorial site for journalist Gašper Stražišar, built on WordPress with a custom theme that keeps the focus where it belongs.",
    links: {
      visitSite: "https://gasperstrazisar.com",
    },
    iconClass: "fas fa-newspaper",
  },
  CWCyprus: {
    category: "professional",
    gradient: "linear-gradient(45deg, #ffcd1c 0%, #ffa41c 100%)",
    title: "Cartridge World Cyprus",
    description: "Internship at Cartridge World Cyprus, working on the development of their WordPress e-commerce site, including SEO and quality assurance.",
    links: {
      visitSite: "https://cwcyprus.com"
    },
    iconClass: "fas fa-print",
  },
  ajsaPetSpa: {
    category: "professional",
    gradient: "linear-gradient(45deg, #D4C49A 0%, #8B7355 100%)",
    title: "Ajsa Pet Spa",
    description: "A polished site for a pet grooming studio, with dynamic price list and photo gallery the owner can update without touching a line of code.",
    links: {
      visitSite: "https://ajsapetspa.com",
    },
    iconClass: "fas fa-paw",
  },

  //? Academic Projects
  thesis: {
    category: "academic",
    gradient: "linear-gradient(45deg, #667eea 0%, #a779e9 100%)",
    badge: "Thesis",
    title: "Virtual Runner",
    description: "My thesis focuses on creating a digital twin of a runner, integrating multiple subprojects into an application to demonstrate practical use of various technologies.",
    links: {
      readMore: "views/thesis",
      code: "https://github.com/orgs/ni-imena/repositories"
    },
    iconClass: "fas fa-running",
    noTarget: "true",
  },
  OCRAlgorithm: {
    category: "academic",
    gradient: "linear-gradient(45deg, #7fc955 0%, #45c2b0 100%)",
    badge: "Research Paper",
    title: "OCR Algorithm for Assisting People with Disabilities",
    description: "An OCR pipeline that reads license plates and faces to grant permit holders with disabilities instant parking access. Awarded a national silver prize for research innovation.",
    links: {
      readMore: "https://www.knjiznica-celje.si/raziskovalne/4202106000.pdf"
    },
    iconClass: "fas fa-file-alt",
  },
  FruitAlgorithm: {
    category: "academic",
    gradient: "linear-gradient(45deg, #f2994a 0%, #f2c94c 100%)",
    badge: "Course Project",
    title: "Fruit Sequence Optimization with Dynamic Programming",
    description: "A direct comparison of brute force and dynamic programming on a deceptively tricky placement puzzle, with runtime charts to prove which one wins.",
    links: {
      code: "https://github.com/domenhribernik/fruit_algorithm"
    },
    iconClass: "fas fa-graduation-cap",
  },

  //? Personal Projects
  guitarBackingTracks: {
    category: "passion",
    gradient: "linear-gradient(45deg, #667eea 0%, #56ccf2 100%)",
    title: "Guitar Backing Tracks",
    description: "I got tired of digging through folders every time I wanted to practice. So I built a simple player that keeps all my backing tracks in one place, ready to go.",
    links: {
      visitSite: "views/music"
    },
    iconClass: "fas fa-music",
  },
  bearing: {
    category: "passion",
    gradient: "linear-gradient(45deg, #272052 0%, #ff6a2b 100%)",
    title: "Bearing",
    description: "A co-op game for two, because every other game here is one of you beating the other. You each sweep a radio antenna and learn which direction a collared animal is in, never how far, so one bearing is a line and only two crossed from different places are a spot on the map. Work out what she is doing from the track you build together, then agree where she will be next and have someone standing there when she arrives.",
    links: { visitSite: "views/bearing" },
    iconClass: "fas fa-satellite-dish",
  },

  battleship: {
    category: "passion",
    gradient: "linear-gradient(45deg, #1156b8 0%, #d81e2c 100%)",
    title: "Battleship",
    description: "Battleship where falling behind pays out. Every hull you lose salvages a heavier weapon, from sonar sweeps and decoy buoys up to a depth charge that flattens a three by three, so the fleet that is burning is the one with options. Play a friend over a four letter room code, or take on the bot.",
    links: {
      visitSite: "views/battleship",
    },
    iconClass: "fas fa-ship",
  },
  seam: {
    category: "passion",
    gradient: "linear-gradient(45deg, #1f8a86 0%, #e0a11c 100%)",
    title: "Seam",
    description: "Connect four, except the ground keeps disappearing. Play into a column that is already full and the deepest row of the whole board is cut away, so every piece drops a row and the line you were building may be gone. You get three of those, and never two turns running.",
    links: {
      visitSite: "views/seam",
    },
    iconClass: "fas fa-layer-group",
  },
  spyGame: {
    category: "passion",
    gradient: "linear-gradient(45deg, #b24592 0%, #f15f79 100%)",
    title: "Spy Game",
    description: "Everyone knows the location except one person. That person is the spy. Pass one phone round the table, or open a room so everyone gets their own screen, votes in secret and finds out together who was lying. Plays in English or Slovenian.",
    links: {
      visitSite: "views/spy",
    },
    iconClass: "fas fa-user-secret",
  },
  tarok: {
    category: "passion",
    gradient: "linear-gradient(45deg, #ff006e 0%, #ff4d4d 100%)",
    title: "Tarok Scoring",
    description: "A scorekeeper for Slovenia's beloved card game. Handles radelci, multipliers, and full game history, so the table argument about who's winning stays settled.",
    links: {
      visitSite: "views/tarok",
    },
    iconClass: "fa fa-trophy",
  },
  beseda: {
    category: "passion",
    gradient: "linear-gradient(45deg, #2f5b53 0%, #7fa89c 100%)",
    title: "Beseda",
    description: "Duolingo doesn't teach Slovenian and the apps that do want your money, so here is a free one. A new word every day inside real sentences, where hovering any word tells you what it means. Keep a streak going if that helps you show up.",
    links: {
      visitSite: "views/beseda",
    },
    iconClass: "fas fa-language",
  },
  tells: {
    category: "passion",
    gradient: "linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)",
    title: "Tells",
    description: "A logical fallacy sits in the argument where anyone can point at it, a cognitive bias sits in your head where nobody can, and a tactic is someone triggering that bias on purpose. Here are 48 of them on one grid, each with what to actually say back. The drill shows you a different example every time, so what you learn is the pattern rather than the sentence.",
    links: {
      visitSite: "views/tells",
    },
    iconClass: "fas fa-crosshairs",
  },
  botaniq: {
    category: "passion",
    gradient: "linear-gradient(45deg, #56ab2f 0%, #a8e063 100%)",
    title: "Botaniq",
    description: "Never forget to water a plant again. Add your plants, set a watering schedule, and write down exactly how to care for each one. Simple and always one glance away.",
    links: {
      visitSite: "views/botaniq",
    },
    iconClass: "fas fa-leaf",
  },
  ipLocator: {
    category: "passion",
    gradient: "linear-gradient(45deg, #11998e 0%, #38ef7d 100%)",
    title: "Multi-Source IP Locator",
    description: "Asks ten independent geolocation services where an IP lives and draws every answer on one map, so you see where the consensus lands and not just one provider's best guess.",
    links: {
      visitSite: "views/ip",
    },
    iconClass: "fas fa-map-marker-alt",
  },
  workout: {
    category: "passion",
    gradient: "linear-gradient(45deg, #f46b45 0%, #eea849 100%)",
    title: "Workout Tracker",
    description: "Build workouts from your own exercise library, whether it's reps, weights, holds, or runs, then log every round as you go. Each session is saved, so you can look back and see yourself getting stronger.",
    links: {
      visitSite: "views/workout",
    },
    iconClass: "fas fa-dumbbell",
  },
  maze: {
    category: "passion",
    gradient: "linear-gradient(45deg, #3d5af1 0%, #22d1ee 100%)",
    title: "Maze Generator",
    description: "Generate your own maze puzzles and print them out. Pick a shape, pick a style, and get a unique maze every time with the solution ready if you need it.",
    links: {
      visitSite: "views/maze",
    },
    iconClass: "fas fa-puzzle-piece",
  },
  sourdough: {
    category: "passion",
    gradient: "linear-gradient(45deg, #c8741a 0%, #f3e3c3 100%)",
    title: "Sourdough Tracker",
    description: "Good sourdough takes days, and it is easy to lose track. This keeps the whole process in one place so you always know where your dough is: fed, folded, proofing, or ready for the oven.",
    links: {
      visitSite: "views/sourdough",
    },
    iconClass: "fas fa-bread-slice",
  },
  blog: {
    category: "passion",
    gradient: "linear-gradient(45deg, #1c1a17 0%, #6b6256 100%)",
    title: "Blog",
    description: "A place to write down the occasional thought on building software and the projects on this site. Rendered straight in the browser.",
    links: {
      visitSite: "views/blog",
    },
    iconClass: "fas fa-book-open",
  },
  recipes: {
    category: "passion",
    gradient: "linear-gradient(45deg, #e0731d 0%, #efe9dd 100%)",
    title: "Recipes",
    description: "A cozy recipe box where anyone can browse and cooks can write their own. A guided cooking mode walks you through each step with built in timers and a bell.",
    links: {
      visitSite: "views/recipes",
    },
    iconClass: "fas fa-utensils",
  },
  flowers: {
    category: "passion",
    gradient: "linear-gradient(45deg, #b13a6e 0%, #f6c1d9 100%)",
    title: "Paper Flowers",
    description: "Build a bouquet out of nothing but CSS: pick roses, sunflowers, poppies and more, and every petal is a flat div rotated into place. Then send someone a link to their arrangement.",
    links: {
      visitSite: "views/flowers",
    },
    iconClass: "fas fa-spa",
  },
  nebo: {
    category: "passion",
    gradient: "linear-gradient(45deg, #0b102a 0%, #2c3e70 100%)",
    title: "Nebo",
    description: "A live map of the night sky: every naked eye star, the five visible planets, and the Moon in its exact phase, computed right in your browser from orbital mechanics. Drag time and watch dusk fall over the dome.",
    links: {
      visitSite: "views/nebo",
    },
    iconClass: "fas fa-moon",
  },
  trails: {
    category: "passion",
    gradient: "linear-gradient(45deg, #0a151d 0%, #ff2d78 100%)",
    title: "Trails",
    description: "Somewhere over the Alps with no wifi, you want to know where you are and what that city under the wing is called. Trails records the whole flight on your phone with no signal at all, draws it on a chart that needs no tiles, and works out what is over the horizon from your altitude.",
    links: {
      visitSite: "views/trails",
    },
    iconClass: "fas fa-plane-up",
  },
  share: {
    category: "passion",
    gradient: "linear-gradient(45deg, #1f35e0 0%, #d4451f 100%)",
    title: "Share",
    description: "Put share. in front of any address on this site and you get a page built to be pointed at a phone: what the project is, what it does, and a QR code big enough to scan across a room. The encoder is written by hand, so the code is drawn without loading anyone else's script.",
    links: {
      visitSite: "views/share",
    },
    iconClass: "fas fa-qrcode",
  }
};

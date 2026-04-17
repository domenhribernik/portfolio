export const projects = {
  //? Professional Projects
  CWCyprus: {
    category: "professional",
    gradient: "linear-gradient(45deg, #ffcd1c 0%, #ffa41c 100%)",
    title: "Cartridge World Cyprus",
    description: "Internship at Cartridge World Cyprus, working on the development of their WordPress e-commerce site, including SEO and quality assurance.",
    tech: ["WordPress", "WooCommerce", "PHP", "Elementor", "SEO"],
    links: {
      visitSite: "https://cwcyprus.com"
    },
    iconClass: "fas fa-print",
  },
  vitaMavric: {
    category: "professional",
    gradient: "linear-gradient(45deg, #f093fb 0%, #f5576c 100%)",
    title: "Vita Mavrič",
    description: "Custom-built, responsive website for Vita Mavrič, developed using HTML, CSS, and vanilla JavaScript.",
    tech: ["HTML", "CSS", "JavaScript"],
    links: {
      visitSite: "https://vitamavric.com",
    },
    iconClass: "fas fa-masks-theater",
  },
  gasperStrazisar: {
    category: "professional",
    gradient: "linear-gradient(45deg, #4facfe 0%, #00f2fe 100%)",
    title: "Gašper Stražišar",
    description: "Custom-built, responsive website for Gašper Stražišar, developed in WordPress with custom themes and functionality.",
    tech: ["WordPress", "CSS", "SEO"],
    links: {
      visitSite: "https://gasperstrazisar.com",
    },
    iconClass: "fas fa-newspaper",
  },
  ajsaPetSpa: {
    category: "professional",
    gradient: "linear-gradient(45deg, #D4C49A 0%, #8B7355 100%)",
    title: "Ajsa Pet Spa",
    description: "WordPress site for a pet salon, built with Elementor and custom-coded components. Features a dynamic price list and gallery.",
    tech: ["WordPress", "Elementor", "PHP"],
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
    tech: ["Blockchain", "Web", "Android", "Data Analysis", "AI", "Game dev", "Parallel computing"],
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
    description: "Research project and implementation of an OCR-based system designed to assist individuals with physical disabilities in accessing parking spaces. Awarded a national silver prize for innovation.",
    tech: ["Python", "OCR", "Face Recognition", "License Plate Recognition", "Web Development"],
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
    description: "Course project tackling a coding challenge on strategic fruit placement to minimize apple picks. Includes both brute-force and dynamic programming solutions and their comparison.",
    tech: ["C++", "Dynamic Programming", "Algorithms"],
    links: {
      code: "https://github.com/domenhribernik/fruit_algorithm"
    },
    iconClass: "fas fa-graduation-cap",
  },

  //? Personal Projects
  wordleBot: {
    category: "passion",
    gradient: "linear-gradient(45deg, #fc6076 0%, #ff9a44 100%)",
    title: "Wordle Bot",
    description: "A Python bot for the game Wordle that uses algorithmic strategies to solve puzzles efficiently, demonstrating AI techniques for word games.",
    tech: ["Python", "Algorithm", "OpenCV"],
    links: {
      code: "https://github.com/domenhribernik/wordle-bot"
    },
    iconClass: "fas fa-robot",
  },
  guitarBackingTracks: {
    category: "passion",
    gradient: "linear-gradient(45deg, #667eea 0%, #56ccf2 100%)",
    title: "Guitar Backing Tracks",
    description: "A personal project built to manage scattered MP3 backing tracks across devices. This custom web player lets you play guitar backing tracks directly in the browser, with a clean and responsive interface tailored for quick practice sessions.",
    tech: ["HTML", "CSS", "JavaScript"],
    links: {
      visitSite: "views/music"
    },
    iconClass: "fas fa-music",
  },
  spyGame: {
    category: "passion",
    gradient: "linear-gradient(45deg, #b24592 0%, #f15f79 100%)",
    title: "Spy Game",
    description: "A simple web-based game where players take turns guessing the location of a spy on a grid. The game is designed for two players and includes basic AI functionality for single-player mode.",
    tech: ["HTML", "CSS", "JavaScript"],
    links: {
      visitSite: "views/spy",
    },
    iconClass: "fas fa-user-secret",
  },
  tarok: {
    category: "passion",
    gradient: "linear-gradient(45deg, #ff006e 0%, #ff4d4d 100%)",
    title: "Tarok Scoring",
    description: "A web-based scoring app for the Slovenian Tarok card game, supporting 3-4 players with real-time score tracking, radelci management, and game history.",
    tech: ["HTML", "CSS", "JavaScript"],
    links: {
      visitSite: "views/tarok",
    },
    iconClass: "fa fa-trophy",
  },
  botaniq: {
    category: "passion",
    gradient: "linear-gradient(45deg, #56ab2f 0%, #a8e063 100%)",
    title: "Botaniq",
    description: "A plant care manager with watering countdown timers, detailed care guides, and image uploads. Track your houseplants and never forget to water them again.",
    tech: ["HTML", "CSS", "JavaScript", "PHP", "SQL"],
    links: {
      visitSite: "views/botaniq",
    },
    iconClass: "fas fa-leaf",
  },
  ipLocator: {
    category: "passion",
    gradient: "linear-gradient(45deg, #11998e 0%, #38ef7d 100%)",
    title: "Multi-Source IP Locator",
    description: "An IP geolocation tool that queries 7 free APIs simultaneously with auto-failover — no API keys needed. Features an interactive Leaflet map, per-source comparison mode, and live API status badges.",
    tech: ["HTML", "CSS", "JavaScript", "Leaflet"],
    links: {
      visitSite: "views/ip",
    },
    iconClass: "fas fa-map-marker-alt",
  }
};

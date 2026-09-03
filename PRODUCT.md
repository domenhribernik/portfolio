# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two distinct audiences share one codebase.

**Visitors to the portfolio.** People evaluating Domen Hribernik's work: recruiters,
collaborators, and people arriving from a link to one specific project. They land on a
project surface as often as on the homepage, so every project has to stand on its own
rather than depend on the site around it.

**People actually using the projects.** Several surfaces here are working tools and
games with real users rather than case studies. The multiplayer games (`spy`, `seam`,
`battleship`, and now `bearing`) are played by two to eight people at a time on their
own phones, usually in the same room or on a call. The private tools (`stocks`, `list`,
`workout`, `dashboard`, and others listed in CLAUDE.md) are used by Domen and a small
number of invited accounts.

## Product Purpose

A personal portfolio that is also the live home of the things it documents. A project
entry is not a screenshot and a write-up; it is the running thing. Success is a visitor
who plays or uses a project rather than reading about it.

## Positioning

The projects are systems rather than demos. Each game is a known form plus one real
mechanical twist, built to be replayed rather than looked at once: `spy` is Spyfall,
`seam` is Connect Four over ground that collapses, `battleship` pays you for losing
hulls. That is what a case-study portfolio cannot copy, because the work has to actually
run and hold up to repeat play.

## Operating Context

- No build system, no package manager, no framework anywhere on the frontend. The root
  `package.json` is a `"type": "module"` marker only and never gains dependencies.
- Production is PHP under Apache with no way to keep a socket daemon alive and no cron.
  This is the single most load-bearing constraint in the repo: it is why every
  multiplayer feature runs on an append-only MySQL event log with adaptive short
  polling, and why housekeeping rides the poll path instead of a scheduler.
- SQL is always applied by hand in phpMyAdmin. Nothing runs migrations automatically, so
  a shipped feature carries a manual production step.
- Local development runs on XAMPP. `app/.env` points at the **remote production**
  database, so test suites must override `DB_*` at the local scratch database.
- Multiplayer games are played across two devices with no account: a four-character room
  code and a secret token stored only as a SHA-256 hash.

## Capabilities and Constraints

- Static HTML, CSS and vanilla JS on the frontend; PHP for API proxying and CRUD; a few
  standalone Python jobs.
- Global accounts exist (Google Sign-In, DB-backed sessions, per-project roles) but the
  games deliberately carry no auth gate at all. A player is a token, not an account.
- Tests are zero-dependency: `node --test` for JS, hand-rolled PHP suites that boot a
  built-in server, one Python suite.
- Non-trivial decision logic is extracted into a DOM-free `logic.js` and tested there
  rather than left tangled in DOM code.
- Some project surfaces are intentionally unlisted and carry `noindex, nofollow`; the
  authoritative list is in CLAUDE.md and must not be inferred from the directory tree.

## Brand Commitments

- The site's own name and voice are Domen Hribernik's; production domain
  `https://domenhribernik.com`.
- No em dashes anywhere in the codebase: descriptions, comments, UI copy, all of it.
- Project descriptions lead with the problem or the twist, never a feature list, and run
  one to three plain conversational sentences.
- The portfolio chrome and private tools run the house design system documented in
  DESIGN.md. Showcase projects are explicitly licensed to commit to their own visual
  world instead, and roughly a dozen already have.
- `bearing` ships English only, unlike the other three games, which are bilingual
  English and Slovenian.

## Evidence on Hand

Everything the site claims is running code in this repository. There are no
testimonials, customers, benchmarks, press mentions, or pricing anywhere in the product,
and none may be invented. The games' own generated content (a night's bearings, a
board, a deal) is the demonstration material.

## Product Principles

1. **A project is a system, not a level.** Procedural and rule-driven beats authored
   content, because the work has to survive repeat play rather than one visit.
2. **The server owns anything a client could forge.** Boards, deals, fleets, and animal
   positions are decided in PHP; the client posts an intent and learns the consequence
   through the poll like everyone else.
3. **The constraint is the design.** No sockets, no cron and no build step are not
   obstacles worked around; they are why the architecture looks the way it does.
4. **A surface stands alone.** Visitors arrive directly at a project, so it carries its
   own head, its own chrome and its own world without leaning on the site.
5. **Extract before you test.** Decision logic moves out of the DOM so it can be held by
   a test, and constants duplicated into PHP are held by a test that reads the PHP.

## Accessibility & Inclusion

No formal standard has been set, but the repo enforces a consistent floor: a real
`:focus-visible` state for every hover affordance, a `prefers-reduced-motion` override
shipped with every animation, warm neutrals over pure black and white, and a documented
ban on native `<input type="date">` because it renders in the browser's locale and swaps
day and month for European visitors. Colour is never the only carrier of state.

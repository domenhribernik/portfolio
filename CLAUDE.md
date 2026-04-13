# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal portfolio website for Domen Hribernik. Pure static site on the frontend — HTML, CSS, and vanilla JavaScript with no build system, package manager, or framework. PHP backend for proxying and database operations.

## Architecture

### Frontend — Page Structure

The main entry point is `index.html` (root), which loads its page-specific logic from [homepage/script.js](homepage/script.js). The `homepage/` folder contains HTML partials, CSS, and JS unique to the landing page.

Each project/feature lives in its own directory named to match its URL path (e.g., `/rocks` → [rocks/](rocks/), `/tarok` → [tarok/](tarok/)). Each directory is self-contained with its own `index.html`, `style.css`, and `script.js`. Global styles shared across all pages are in [base-style.css](base-style.css).

Current project directories: `about`, `homepage`, `iliana`, `ip`, `music`, `on-this-day`, `quizz`, `rocks`, `spy`, `tarok`, `thesis`.

### Frontend — Component System

Reusable web components live in [components/](components/) and are imported as ES modules via `<script type="module">`:

- [components/gallery.js](components/gallery.js) — Dynamic image gallery/carousel component
- [components/main-navbar.js](components/main-navbar.js) — Site-wide navigation bar
- [components/project-card.js](components/project-card.js) — Project display card
- [components/project-data.js](components/project-data.js) — **Central data registry** for all portfolio projects; add new projects here

### Backend (PHP)

The [app/](app/) directory contains the PHP backend, structured as follows:

- [app/config/](app/config/) — Database access and other configuration (e.g., `database.php`, `dev-mode.php`)
- [app/models/](app/models/) — SQL / data storage definitions
- [app/controllers/](app/controllers/) — CRUD operations for the database
- [app/services/](app/services/) — Higher-level functions that compose controllers; called by the frontend when logic is complex
- [app/proxys/](app/proxys/) — External API call proxies (hides API keys from the client). Current proxies: NASA APOD, On This Day
- [app/cache/](app/cache/) — Cached responses from proxies to avoid redundant external fetches
- [app/vendor/](app/vendor/) — Composer dependencies (phpdotenv for `.env` loading)

When developing locally without XAMPP running, requests that go through PHP proxies/services will fail.

### Assets

All media (images, video, audio, documents) and data files live in [assets/](assets/).

## Adding a New Project

1. Add an entry to [components/project-data.js](components/project-data.js) following the existing schema (`title`, `description`, `tech`, `links`, `iconClass`). 
2. Make sure to specify in which sections they should go (`Professional Projects`, `Academic Projects`, `Personal Projects`)
3. Create a new directory matching the desired URL path, with `index.html`, `script.js`, `style.css`.
3. Import shared components and `base-style.css` from the project page using relative paths. Add the project in `index.html`

## External Dependencies

Loaded via CDN — no local install needed:
- FontAwesome (icons)
- Google Fonts
- Devicons (tech stack icons)

## License

CC BY-NC-ND 4.0 — non-commercial use only, no derivatives.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal portfolio website for Domen Hribernik. Pure static site on the frontend — HTML, CSS, and vanilla JavaScript with no build system, package manager, or framework. PHP backend for proxying and database operations.

## Architecture

### Frontend — Page Structure

The main entry point is `index.html` (root), which loads its page-specific logic from [views/homepage/script.js](views/homepage/script.js). The `views/homepage/` folder contains CSS and JS unique to the landing page.

All page directories live under [views/](views/), named to match their URL path (e.g., `/views/rocks` → [views/rocks/](views/rocks/), `/views/tarok` → [views/tarok/](views/tarok/)). Each directory is self-contained with its own `index.html`, `style.css`, and `script.js`. Global styles shared across all pages are in [base-style.css](base-style.css).

Current project directories: `views/about`, `views/botaniq`, `views/homepage`, `views/iliana`, `views/ip`, `views/jeger`, `views/music`, `views/on-this-day`, `views/quizz`, `views/rocks`, `views/slovenia`, `views/spy`, `views/tarok`, `views/thesis`.

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

1. **Register the project** in [components/project-data.js](components/project-data.js) following the existing schema (`title`, `description`, `tech`, `links`, `iconClass`). Place the entry under the correct comment section (`Professional Projects`, `Academic Projects`, `Personal Projects`).
2. **Add a `<project-card>` tag** to [index.html](index.html) inside the matching category's `.projects-grid` div. Pick a gradient that fits the project's theme. The `project` attribute must match the key used in `project-data.js`.
3. **Create the project directory** under `views/` matching the desired URL path (e.g., `views/botaniq/`), containing `index.html`, `style.css`, and `script.js`. Import shared components (`main-navbar.js`, etc.) and `base-style.css` using `../../` relative paths (two levels up to reach the root).
4. **If the project uses a database**, create an SQL model file at `app/models/<name>-model.sql` with the `CREATE TABLE` and seed `INSERT` statements. SQL is always executed manually via phpMyAdmin — never run SQL from code or migrations automatically. Create the corresponding controller at `app/controllers/<name>-controller.php` following the existing CRUD pattern.
5. **Update the project directory list** in this file's "Frontend — Page Structure" section.

## External Dependencies

Loaded via CDN — no local install needed:
- FontAwesome (icons)
- Google Fonts
- Devicons (tech stack icons)

## License

CC BY-NC-ND 4.0 — non-commercial use only, no derivatives.

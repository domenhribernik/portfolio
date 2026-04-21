# Ideas

## In Progress / Priority

- **Music app** — upgrade by adding db, chords on lyrics, auto follow allong 
  - Free APIs that actually exist
    - Uberchord — free, has a large database of guitar chords with fingering dat (which strings, which frets, which fingers). Returns JSON with the full chord shape. Uberchord Good for rendering chord diagrams on your site.
    - Scales-Chords API — free, no activation needed, returns chord charts and sounds for guitar or piano. You just include their JS file and request chords by name. Scales-Chords.com
    - Hooktheory — has an API that exposes chord probability data, letting you query what chords most commonly follow a given progression. Useful for theory-based suggestions rather than song-specific lookups. Hooktheory
    - Songsterr — provides guitar, bass, and drum tabs/chords and doesn't require an API key, though it has no CORS support so you'd need to proxy through your PHP backend.
- **Registration & auth system** *(priority)*
  - Add user schema
  - Add `author`, `date_added`, `date_modified` tags to all records
  - Admin page with secure access
  - Google OAuth + account linking with classic accounts
- **IP** — finish
- **Make automatic commit** - git action - to my ftp
- **Look into unit testing**, and add them before commit. And on actions as well? 
- **Add skills** - learn how to make skills and add as many as you can think of
- Add webp to image service, and then also figure out the jpg edge case

## Refactoring

- Restyle every project with Tailwind CSS
- Figure out how to seperate git repositories, to seperate the big projects, people would be interested in seeing

## Project Ideas

- **Garage door** — open with website
- **Dynamic maze generator** + print
- **ASCII art converter** — transform images to ASCII (lightest to darkest); already have a project, put it on the portfolio
- **Pixel encoder to YouTube video** — encode data into video frames (B&W and RGB); explore glitch AI art angle to avoid content removal
- **QR / barcode generator**
  - Free tier: simple QR codes with colors/logos
  - Paid tier: dynamic QR codes, analytics, bulk generation
  - Static codes cost nothing to host and are highly shareable
- **Historic period explorer** — website that presents a historic period in sequence with nice design, lets users follow along or quickly learn something; QR code to scan and read about it on the go. Present as a prototype/concept to gauge interest.
- **Pravna zakonodaja (SLO)** — Brezplačna spletna stran, ki pomaga ljudem razumeti zakone in njihove spremembe. Neke vrste vodič skozi zakonodajo. Posvetovati se s pravniki/odvetniki pred objavo.
- **Every app in one place** — Example is my workout project, it does 3 things better than mobile apps: 
  - Personalized design, no paying for dark theme
  - Data is under my control, can write any query to group data, and can ask chatgpt for workout advice based on the specific data / trend
  - No ads, completely free to use, from any device (pc, iphone, android)
  - Fast development, took me 5 minutes to create the workout app (ui, not connected to db)
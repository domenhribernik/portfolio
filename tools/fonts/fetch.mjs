/* ============================================================
   Refresh assets/fonts/ from Google Fonts.

       node tools/fonts/fetch.mjs

   The site self-hosts its webfonts: hot-linking fonts.googleapis.com
   hands every visitor's IP to Google before they have agreed to
   anything. This tool is how the local copies are produced, so the
   set stays reproducible instead of being a folder nobody dares
   touch.

   ADDING A FACE: add its Google Fonts css2 URL to SOURCES below and
   re-run. Do not hand-edit assets/fonts/fonts.css, it is generated.
   ============================================================ */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

//? Every css2 URL the site used before the fonts were brought in-house.
const SOURCES = [
    "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Martian+Mono:wght@400..700&display=swap",
    "https://fonts.googleapis.com/css2?family=Bevan&family=Barlow+Condensed:wght@400;500;600;700&family=Azeret+Mono:wght@400;500;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=Big+Shoulders+Text:wght@400;500;600;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Share+Tech+Mono&family=Special+Elite&display=swap",
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Sans:ital,wght@0,300..600;1,400&family=Space+Mono:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap",
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap",
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Sans:wght@300;400;500;600&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap",
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Sans:wght@300;400;500;600&family=Space+Mono:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;600;700&family=Poppins:wght@300;400;500;600&display=swap",
    "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Poppins:wght@400;500;600&display=swap",
    "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:ital,wght@0,500;0,600;0,700;1,600&family=Silkscreen:wght@400;700&family=Space+Mono:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Fira+Mono:wght@400;500;700&family=Fira+Sans+Condensed:wght@400;500;700&family=Fira+Sans:wght@400;500&display=swap",
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap",
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=Karla:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
    "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@400;500;600;700&family=Alegreya:ital,wght@0,400;0,500;0,700;1,400;1,500&display=swap",
    "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Albert+Sans:wght@300;400;500;600&family=Fragment+Mono:ital@0;1&display=swap",
    "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap",
    "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=UnifrakturMaguntia&family=Caveat:wght@400;700&family=Special+Elite&display=swap",
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Special+Elite&display=swap",
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Saira+Stencil+One&family=Saira+Condensed:wght@400;600;800&family=Saira:wght@400;500&family=Chivo+Mono:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap"
];

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'assets', 'fonts');
const FILE_DIR = path.join(OUT_DIR, 'files');

// Latin coverage only. Slovenian (č š ž) lives in latin-ext; cyrillic, greek
// and vietnamese would multiply the file count for text this site never sets.
const KEEP = new Set(['latin', 'latin-ext']);

const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

fs.mkdirSync(FILE_DIR, { recursive: true });

const blocks = new Map(); // signature -> css text
const files = new Map(); // remote url -> local basename
let skipped = 0;

for (const url of SOURCES) {
    process.stderr.write(`fetching ${url.slice(0, 90)}\n`);
    const css = execSync(
        `curl -sS -m 30 -A ${JSON.stringify(UA)} ${JSON.stringify(url)}`,
        { encoding: 'utf8', maxBuffer: 1 << 26 }
    );

    const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        const subset = m[1];
        const body = m[2];
        if (!KEEP.has(subset)) { skipped++; continue; }

        const srcMatch = body.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
        if (!srcMatch) continue;
        const remote = srcMatch[1];

        if (!files.has(remote)) {
            const family = (body.match(/font-family:\s*'([^']+)'/) || [, 'font'])[1]
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-');
            const weight = (body.match(/font-weight:\s*([^;]+)/) || [, ''])[1]
                .trim()
                .replace(/\s+/g, '-');
            const style = (body.match(/font-style:\s*([^;]+)/) || [, 'normal'])[1].trim();
            const hash = path.basename(new URL(remote).pathname, '.woff2').slice(-8);
            const name = `${family}-${weight}-${style}-${subset}-${hash}.woff2`;
            files.set(remote, name);
        }
        const local = files.get(remote);

        const rewritten = body
            .replace(/url\(https:\/\/fonts\.gstatic\.com\/[^)]+\)/, `url(files/${local})`)
            .trim();

        // Dedupe: the same family/weight/subset appears across many page URLs.
        const sig = rewritten.replace(/\s+/g, ' ');
        if (!blocks.has(sig)) blocks.set(sig, { subset, css: rewritten });
    }
}

process.stderr.write(`\n${files.size} font files, ${blocks.size} @font-face rules (skipped ${skipped} non-latin)\n`);

let done = 0;
for (const [remote, name] of files) {
    const dest = path.join(FILE_DIR, name);
    if (fs.existsSync(dest)) { done++; continue; }
    execSync(`curl -sS -m 30 -A ${JSON.stringify(UA)} -o ${JSON.stringify(dest)} ${JSON.stringify(remote)}`);
    done++;
    if (done % 20 === 0) process.stderr.write(`  downloaded ${done}/${files.size}\n`);
}
process.stderr.write(`  downloaded ${done}/${files.size}\n`);

const header = `/* ============================================================
   Every webfont the site uses, served from this domain.

   GENERATED by tools/fonts/fetch.mjs. Do not hand-edit: re-run the
   tool instead. Latin and latin-ext subsets only, which is what an
   English site with Slovenian names needs.

   These used to be <link>s to fonts.googleapis.com. Hot-linking sends
   every visitor's IP to Google before they have agreed to anything,
   which is the exact arrangement LG Munchen I ruled against in 2022,
   so the files live here now. tests/legal.test.mjs fails if a page
   goes back to hot-linking them.
   ============================================================ */

`;

const ordered = [...blocks.values()].sort((a, b) =>
    a.css.localeCompare(b.css)
);

const body = ordered
    .map((b) => `/* ${b.subset} */\n@font-face {\n  ${b.css.replace(/\n\s*/g, '\n  ')}\n}`)
    .join('\n\n');

fs.writeFileSync(path.join(OUT_DIR, 'fonts.css'), header + body + '\n');
process.stderr.write(`wrote assets/fonts/fonts.css\n`);

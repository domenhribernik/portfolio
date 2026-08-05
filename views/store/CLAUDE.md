# views/store (Everbloom)

The folder is `store`; the brand is **Everbloom**. A commercial landing page, currently at
**waitlist stage**, selling permanent, scheduled versions of the
[views/flowers](../flowers/) bouquets.

**Not a portfolio project.** Keep it out of `components/project-data.js` and the navbar.

Business and launch plan: [PLAN.md](PLAN.md).

## Styling: no Tailwind here

It reuses the flowers engine and stylesheets exactly like [views/flowers/share/](../flowers/share/)
does: hand-written CSS, no Tailwind CDN. The reason is cold-open speed, this is a page
strangers land on from a link. Don't "modernize" it onto Tailwind.

## Backend

[app/proxys/store.php](../../app/proxys/store.php), table `store_waitlist` in
[app/models/store-model.sql](../../app/models/store-model.sql).

- **POST** mirrors the `contact.php` shape: validation, a hidden honeypot that silently
  drops bots, a best-effort Telegram alert. One row per email, upserted on duplicate.
- **GET `?action=count`** feeds the storefront's founding-spots line, so the scarcity copy
  is always the real number and never invented.

Pure logic is [logic.js](logic.js), tested by
[tests/store-logic.test.mjs](../../tests/store-logic.test.mjs).

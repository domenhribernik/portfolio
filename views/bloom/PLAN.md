# Everbloom: business and launch plan

A digital flower shop built on the Paper Flowers engine (`views/flowers`). People send a
handcrafted 3D bouquet that blooms when opened, delivered by link on the date that matters.
The free builder already exists and already spreads itself (every share link is an ad);
Everbloom is the paid layer on top: permanence, scheduling, and a subscription.

Written 2026-07-13, using the `offers`, `pricing`, `launch`, `marketing-plan`, and
`marketing-psychology` skills in `.claude/skills/`.

## 1. Why this product

The brief: recurring revenue, e-commerce shaped, without walking into a saturated market
(shirts were rejected for exactly that reason).

- **The hard part is already built.** Ten flower species, share links, server storage,
  tests. Competitors would have to want to build a CSS 3D flower engine. Nobody sane does.
- **Zero marginal cost, zero inventory, zero shipping.** Every objection to shirt
  e-commerce (stock, print partners, returns, thin margins) disappears. A bouquet costs
  nothing to deliver and ships to any country instantly.
- **The competition is real flowers, and we undercut them on every axis that matters to a
  specific buyer.** A delivered bouquet costs 40-60 EUR, dies in five days, and often can't
  cross a border in time. Ours costs less than a coffee, never wilts, and arrives the
  second it should.
- **Recurring revenue is native, not bolted on.** Gifting has a calendar: birthdays,
  anniversaries, monthiversaries, apologies, "thinking of you." A subscription that
  remembers the dates and delivers automatically renews itself by design.
- **The viral loop already runs.** Every free bouquet sent is an interactive ad opened by
  exactly the kind of person who sends bouquets back.

## 2. Positioning and audience

**One-liner:** flowers that never wilt, delivered anywhere on earth in one second.

**Primary buyer: the long-distance partner** (student couples, expat couples, deployed
partners). Real flower delivery across borders is expensive, unreliable, or impossible.
They already send links, playlists, and games to each other. High occasion frequency
(monthiversaries are a real thing in this segment) makes them natural subscribers.

**Secondary buyer: the last-minute gifter.** It is 23:40 the night before her birthday.
Nothing physical can arrive anymore. We are the only florist still open.

**Tertiary: the internet-culture gifter** who sends things because they are delightful,
found via Reddit/TikTok. Low intent, high volume, feeds the free tier.

Positioning against alternatives (value-based pricing: price sits between the next best
alternative and perceived value):

| Alternative | Cost | Weakness we exploit |
|---|---|---|
| Real bouquet delivered | 40-60 EUR | dies in days, borders, lead time |
| E-card / GIF | free | zero effort signal, feels cheap |
| Star-map / photo gift prints | 30-50 EUR | shipping wait, one-shot, crowded market |
| Doing nothing (forgot) | relationship damage | we sell insurance against this |

The paid product is priced as "far above a GIF, far below a real bouquet, and it lasts
forever."

## 3. The offer (anatomy per the `offers` skill)

Value equation: dream outcome = "I made them feel loved, visibly, on the right day."
Likelihood is proven by the live free demo (they can try the exact product before paying).
Time delay is zero (instant delivery). Effort is near zero (pick stems, write note, done).
The weak lever is *perceived legitimacy of paying for a link*; the guarantee and the
printable keepsake exist to fix exactly that.

| Component | Choice |
|---|---|
| Core deliverable | A personalized bouquet page: their name, your note, chosen stems, delivered by email/link on a scheduled date, permanent |
| Bonus stack | Printable A5 botanical postcard (PDF) of the exact bouquet; seasonal species drops for subscribers; a "vase shelf" page collecting every bouquet a couple has exchanged |
| Guarantee | The Smile Guarantee: full refund within 7 days, no questions, and the bouquet stays live anyway. Costs us nothing (zero marginal cost) and kills the "paying for a link" objection |
| Scarcity | Real, not manufactured: 100 founding subscriptions at 4 EUR/mo locked for life; price rises to 6 EUR/mo at public launch. Enforced by counting waitlist rows |
| Name | **Everbloom** (shop) / **Forever Bouquet** (one-off) / **Petal Post** (subscription) |
| Price | Below. One-off anchors the subscription |

## 4. Pricing

Value metric: *deliveries that matter*. It scales with relationship count and occasion
count, is trivially understood, and can't be gamed.

| Tier | Price | What it is |
|---|---|---|
| The Stall (free) | 0 | The existing builder. Share links wilt after 7 days. Lead magnet and viral loop; never crippled |
| Forever Bouquet | 9 EUR one-time | One permanent, personalized, scheduled bouquet. The impulse buy and the anchor |
| Petal Post (recommended) | 4 EUR/mo founding (6 after) or 36 EUR/yr | All your dates scheduled, every bouquet permanent, seasonal species first, one surprise "just because" delivery per month |

Rationale: 9 EUR one-off makes 4 EUR/mo read as obviously better value after two occasions
(decoy/anchoring). Annual at 36 EUR is 25% off, standard SaaS discount band, and fits
gifting ("a year of flowers" is itself giftable). Charm pricing skipped: round numbers
read more premium and this is a premium-feel, low-price product.

Unit economics: hosting is already paid, marginal cost per bouquet ~0. Stripe fee on a
4 EUR charge is ~0.36 EUR (9%); acceptable, and annual billing drops it to ~2%. 100
founding subs = 400 EUR MRR ceiling at the locked price; the real business is post-launch
at 6 EUR/mo plus one-offs around occasions (Valentine's, Mother's Day spikes).

## 5. Growth model (AARRR)

- **Acquisition.**
  - *The share loop (owned, primary):* every shared bouquet's page gets one quiet footer
    line: "Make one back, it's free" and "Make this one permanent, 9 EUR." The recipient
    is a warm lead by definition.
  - *Short video (rented):* the product is literally a bloom animation, made for
    TikTok/Reels/Shorts. Content: "I built a florist that never closes," species-drop
    reveals, "send this to someone who is far away."
  - *Reddit (rented):* r/LongDistance (500k+ members, gift threads weekly),
    r/InternetIsBeautiful (the free builder qualifies on its own merits).
  - *SEO (owned, slow burn):* "send flowers online free," "digital bouquet," "virtual
    flowers for girlfriend," plus one comparison page per occasion. Programmatic-seo
    skill applies later.
  - *Product Hunt (borrowed, one shot):* launch the free builder as the hook, shop as
    the monetization footnote. The builder is unusual enough to place.
- **Activation:** first bouquet built and shared within one session (already true today).
- **Retention:** the subscription IS a retention machine: scheduled dates mean the product
  works precisely when the user isn't thinking about it. Seasonal species drops (a new
  flower every month or two) give subscribers a reason to stay after the anniversary.
- **Referral:** every delivery lands in front of a new person (built-in). Later: "give a
  month of Petal Post" gift codes.
- **Revenue:** founding subs now, one-offs at open, price step to 6 EUR/mo at public launch.

## 6. Launch plan (five phases, per the `launch` skill)

1. **Internal (done, in effect):** the builder has been live and verified; friends have
   sent bouquets.
2. **Alpha (this prototype):** the Everbloom storefront at `views/bloom` with a founding
   waitlist. Goal: 100 emails. Promote the free builder, let the shop page convert.
3. **Beta:** wire Stripe (Payment Links are enough, no custom integration), build the
   permanent-bouquet store (the `flowers.php` JSON store minus the 7-day prune, plus a
   paid flag), invite the waitlist in batches, founding price honored.
4. **Early access:** scheduled delivery via cron (the repo already runs cron for
   `check_stocks.py`; a `send_bouquets.py` that emails/telegrams due links is a small
   script), the printable postcard PDF, the vase shelf.
5. **Full launch:** Product Hunt + Reddit + video push in the run-up to Valentine's Day
   2027 (the single best calendar moment this product will ever have; work backward from
   February 1st).

## 7. What the prototype contains (phase 2, built today)

- `views/bloom/`: storefront. Live 3D hero bouquet (reuses the flowers engine the same
  way `views/flowers/share/` does), offer sections, pricing tiers, FAQ, founding waitlist
  form. Hand-written CSS on the flowers design system, no Tailwind, same reasoning as the
  share page (cold opens on phones, and the engine's stylesheets are already the design
  system).
- `views/bloom/logic.js`: DOM-free signup validation, founding-spots copy, plan math.
  Tested by `tests/bloom-logic.test.mjs`.
- `app/proxys/bloom.php`: POST stores a waitlist row (`bloom_waitlist`) and fires the
  owner Telegram alert; GET `?action=count` returns claimed/cap for honest scarcity copy.
  Mirrors `contact.php`.
- `app/models/bloom-model.sql`: the table. Run manually via phpMyAdmin, as always.

Deliberately not built yet: payments, permanent storage, scheduling, PDFs. The waitlist
proves demand before any of that is worth building.

## 8. KPIs and kill criteria

- Waitlist: 100 founding emails within 60 days of actually promoting (share-loop line +
  2 Reddit posts + 10 short videos). Under 30 in that window: the offer or the audience is
  wrong; run the diagnostic loop in the `offers` skill before building anything further.
- Free-to-paid at beta open: target 25% of waitlist converts to founding sub or first
  Forever Bouquet.
- Post-launch: 200 EUR MRR by month 3 justifies continued build; churn under 8%/mo
  (occasion products churn seasonally; annual plans are the hedge).

## 9. Risks

- **"It's just a link" skepticism.** Mitigated by the guarantee, the printable, and the
  live demo. If it persists, the printable postcard moves from bonus to headline.
- **Platform dependence for acquisition.** Rented channels funnel to the email list from
  day one (the waitlist is the owned asset).
- **Single maintainer.** The "forever" promise is backed by the printable export, stated
  plainly in the FAQ. Don't over-promise beyond that.
- **Seasonality.** Valentine's/Mother's Day spikes, summer troughs. Subscriptions and the
  monthiversary segment smooth it.

## 10. Products considered and not built

Evaluated against: existing assets, competition density, recurring potential, and owner
taste (paper/ink editorial, handcrafted-web aesthetic). Full reasoning in the build
conversation; short list: personalized star-map prints (nebo engine, proven demand but a
crowded print market), maze-art prints (novel, weak demand), productized dev retainer
(recurring but sells time, not a product), sourdough/recipe club (audience mismatch),
premium tarok scorekeeper (tiny market), digital gift bundle platform (too broad for a
first product). The bouquet shop won on every axis except "proven market," which the
waitlist exists to test cheaply.

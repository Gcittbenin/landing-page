# GCITT — Cité Cœur Joie

Landing page for GCITT BENIN SA, presenting the Cité Cœur Joie and Cité Bethel
villa developments in Abomey-Calavi, Benin — with automated lead capture that
notifies the sales team over WhatsApp Business and email.

The page itself was imported from the Claude Design project
`GCITT - Cite Coeur Joie`.

---

## Architecture

```
Landing page  (GCITT - Cite Coeur Joie.dc.html)
      │  POST /api/lead
      ▼
API backend   (api/lead.js → lib/handler.js)
      │  validation · honeypot · fill-time · rate limit · origin check
      ▼
Fan-out, in parallel
      ├── WhatsApp Business Cloud API  → GCITT sales number
      ├── Email                        → GCITT sales inbox
      └── CRM webhook                  → reserved for a future CRM
```

No API key ever reaches the browser. The page only talks to `/api/lead`, and
that endpoint never echoes configuration back.

---

## Layout

| Path | Role |
| --- | --- |
| `GCITT - Cite Coeur Joie.dc.html` | The page: template markup plus the `DCLogic` component that drives it. |
| `support.js` | The `dc-runtime` — parses `<x-dc>`, binds `{{ … }}`, mounts with React. |
| `uploads/` | Photography and the GCITT logo. |
| `assets/tracking-config.js` | GA4 / GTM / Meta Pixel IDs. **Edit this to switch tracking on.** |
| `assets/tracking.js` | Loads the configured tags, exposes `gcittTrack()`, resolves acquisition source, tracks scroll depth. |
| `assets/responsive.css` | Phone and tablet layout. The design was authored desktop-only. |
| `assets/fonts.css`, `assets/fonts/` | Self-hosted Newsreader and Plus Jakarta Sans. |
| `vendor/` | Self-hosted React 18.3.1 UMD builds. |
| `robots.txt`, `sitemap.xml`, `site.webmanifest`, `favicon.ico` | Crawler and installability files. |
| `api/lead.js` | Vercel serverless adapter (inert on LWS). |
| `server.js` | The server: static files + `/api/lead`, with compression, caching and security headers. |
| `lib/` | The backend proper — see below. |
| `test/` | 124 tests, no dependencies (`node:test`). |
| `docs/WHATSAPP.md` | Meta credentials, the template to submit, error codes. |
| `docs/DEPLOIEMENT.md` | Vercel and standalone deployment, production checklist. |
| `DEPLOIEMENT_LWS.md` | **LWS deployment**: Node version, startup file, panel variables, verification. |

`lib/` breaks down as `handler.js` (the endpoint, framework-agnostic),
`validate.js` (allow-list validation), `format.js` (per-channel rendering),
`whatsapp.js`, `email.js`, `crm.js`, `ratelimit.js`, `config.js`.

---

## Running it

```sh
cp .env.example .env          # fill in the values
npm start                     # server.js loads .env itself when present
#  page → http://localhost:3000
#  API  → POST http://localhost:3000/api/lead
```

`PORT` is read from the environment, so a host that assigns one (LWS, Vercel)
works with no change; 3000 is only the local fallback. There are **no npm
dependencies** — the server uses `node:http`, `node:zlib` and `node:crypto`
only, so `npm install` has nothing to fetch and cannot fail on the host.

Without a `.env`, the page still works end to end: unconfigured channels are
reported as *skipped*, not *failed*, so the form submits and confirms normally.

```sh
npm test
```

The page must be served over HTTP — opening the `.dc.html` from `file://` will
not work, because `support.js` needs a real origin. Everything else is
self-hosted, so the page has no third-party runtime dependency: React is
served from `/vendor` (via the `window.__resources` override `support.js`
honours) and the fonts from `/assets/fonts`.

---

## Lead capture

The form collects: full name, WhatsApp number, email, country of residence,
**cité** (Cœur Joie or Bethel), **villa type** (F4 / Duplex / Autre), the
specific villa, project timeframe, budget, and a free-text message.

Two fields are filled in without the prospect touching them:

- **Submission date** — set server-side. A client-supplied timestamp is not
  evidence, so it is ignored.
- **Acquisition source** — resolved by `assets/tracking.js` from UTM tags, then
  ad click IDs (`gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `li_fat_id`,
  `msclkid`), then the referrer host: Google, Facebook, Instagram, TikTok,
  YouTube, LinkedIn, WhatsApp, or Direct. Kept in `sessionStorage`, so a
  prospect who arrives from TikTok and later reloads the page directly is still
  attributed to TikTok. The raw `utm_source/medium/campaign/content/term` and
  the click ID travel with the lead too, so campaign reporting can join on the
  exact values the ad platform sent.

Choosing a villa — on a card or in the form — fills in its cité and type
automatically. The server re-derives both from the villa catalogue rather than
trusting what the browser sent.

---

## Notifications

**WhatsApp** goes to `GCITT_SALES_WHATSAPP` in the agreed format (`🚨 NOUVEAU
PROSPECT GCITT`, name, phone, email, project, message, date, call to action).

Meta only allows free-form text inside a 24-hour customer-service window, which
a business-initiated alert is normally outside of — so **production needs an
approved template**. Set `META_WHATSAPP_TEMPLATE_NAME` and the code sends the
template; leave it empty and it sends free-form text, which is fine for
testing. `docs/WHATSAPP.md` has the exact template body to submit.

The **prospect** also receives a branded acknowledgement (`EMAIL_CONFIRMATION_ENABLED`,
on by default) naming them, their villa and their cité, with the GCITT contact
details and a WhatsApp button. It is deliberately excluded from the 502 check:
if it bounces, the sales team has still been alerted and the lead is safe, so
showing the prospect an error would be wrong.

**Email** carries the full lead summary, subject `Nouveau prospect - Demande
villa GCITT — <project>`, with the project appended so the inbox is triageable
at a glance. `Reply-To` is the prospect, so replying reaches them directly.
Resend and SendGrid are both supported via `EMAIL_PROVIDER`.

**CRM** is a placeholder: set `CRM_WEBHOOK_URL` and each lead is POSTed there as
JSON. Point it at a CRM's native webhook, a Zapier/Make catch hook, or your own
adapter.

The three run in parallel and none of them can throw, so one failing provider
never blocks the others. If a *configured* channel fails, the API answers `502`
and the form tells the prospect to use WhatsApp instead — better than showing a
confirmation when nobody was actually notified. Every lead is also written to
the server log as a last-resort record.

---

## Security

- Tokens live only in environment variables, never in the frontend, never in a
  response body. `.env` is git-ignored.
- Allow-list validation: unknown fields are dropped, known fields are
  length-capped, enumerated fields must match a known value, control characters
  are stripped.
- Three anti-spam layers: a hidden honeypot field, a minimum fill time
  (`MIN_FILL_MS`, default 3 s), and a per-IP sliding-window rate limit. Bots get
  a `200` with nothing sent — telling them they were detected only helps them
  adapt.
- Cross-origin posts are rejected; `ALLOWED_ORIGINS` overrides the default
  same-origin rule.
- Body size capped at 16 KB, every outbound call has a timeout.
- All lead values are HTML-escaped in the email body.

The rate limiter is in-memory, so on serverless it applies per warm instance
rather than globally. `docs/DEPLOIEMENT.md` explains the one-function upgrade
to a shared store.

---

## Tracking

Fill in `assets/tracking-config.js`:

```js
window.GCITT_TRACKING = {
  ga4: 'G-XXXXXXXXXX',
  gtm: 'GTM-XXXXXXX',
  metaPixel: '000000000000000',
  debug: false,
};
```

Each tag only loads when its ID is present, so an unconfigured tag makes no
network request. If you route GA4 and the Pixel through GTM, set `gtm` alone to
avoid double-counting.

Events reaching GA4, the `dataLayer` and the Meta Pixel:

| Event | Fires when | Meta Pixel |
| --- | --- | --- |
| `whatsapp_click` | any WhatsApp button, with `location` | `Contact` |
| `form_start` | first interaction with the form | `InitiateCheckout` |
| `form_submit` | submit pressed, request sent | custom |
| `generate_lead` | **the API confirmed the lead** | `Lead` |
| `select_item` | "Choisir cette villa" on a card | custom |
| `scroll` | 25 / 50 / 75 / 90 % depth reached | not sent |

`generate_lead` is the conversion to optimise campaigns against — it fires only
on a confirmed server response, not on click, so it does not count failed
submissions.

---

## Content

Villa specs, prices, and FAQ copy are data-driven — they live in
`renderVals()` at the bottom of the `.dc.html`. Edit them there rather than in
the markup. The villa catalogue is mirrored in `lib/validate.js`
(`VILLA_INDEX`); if you add a villa, add it in both places.

---

## SEO

All SEO tags live in the **static** `<head>`, not in the `<helmet>` block
inside `<x-dc>`. Helmet content is injected only once React has mounted, and
the crawlers for Facebook, LinkedIn, WhatsApp and X do not run JavaScript —
anything they must read has to be in the served HTML.

Covered: title, meta description, canonical, robots, `lang="fr"`, Open Graph,
Twitter Cards, favicons, web manifest, `robots.txt`, `sitemap.xml`, and JSON-LD
for Organization, RealEstateAgent (with the four villa offers), WebSite,
WebPage, BreadcrumbList and FAQPage. The prices in the structured data are
asserted against the prices visible on the page, since Google penalises
markup that contradicts the rendered content.

## Performance

Measured with Lighthouse against `npm start`:

| | Performance | Accessibility | Best practices | SEO |
| --- | --- | --- | --- | --- |
| Desktop | 100 | 100 | 100 | 100 |
| Mobile | 78 | 100 | 100 | 100 |

Desktop: FCP 0.5 s, LCP 0.8 s, TBT 0 ms, CLS 0.

The server compresses text responses with Brotli or gzip (HTML 86 KB → 16 KB,
`support.js` 69 KB → 17 KB), sets a year's immutable cache on `/uploads`,
`/assets` and `/vendor`, and answers conditional requests with `304`. On Vercel
`vercel.json` does the same job; the two need to be kept in step.

The mobile figure is Lighthouse's simulated slow 4G with a 4x CPU slowdown.
It is bounded by the page being **client-rendered**: nothing paints until
`support.js` plus React (~197 KB) have downloaded and hydrated. Pre-rendering
the HTML at build time is the only way past that ceiling — see
`docs/DEPLOIEMENT.md`.

## Known limitations

- **Mobile Lighthouse performance is capped around 72** by client-side
  rendering, as above. Every other lever has been pulled: images optimised and
  served with `srcset`, fonts and React self-hosted, LCP image preloaded,
  below-the-fold images lazy-loaded.
- **`support.js` and `tracking.js` are not minified.** They are served
  compressed, which recovers most of the difference; Lighthouse estimates the
  remaining saving at ~150 ms on mobile. Minifying would mean adding a build
  step to what is currently a zero-dependency static deploy.
- **The rate limiter is in-memory**, so it resets on restart and, if the host
  runs more than one process, each has its own counter.

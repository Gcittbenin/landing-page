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
| `assets/tracking.js` | Loads the configured tags, exposes `gcittTrack()`, resolves acquisition source. |
| `api/lead.js` | Vercel serverless adapter. |
| `server.js` | Local dev / self-hosted server: static files + `/api/lead`. |
| `lib/` | The backend proper — see below. |
| `test/` | 73 tests, no dependencies (`node:test`). |
| `docs/WHATSAPP.md` | Meta credentials, the template to submit, error codes. |
| `docs/DEPLOIEMENT.md` | Vercel and standalone deployment, production checklist. |

`lib/` breaks down as `handler.js` (the endpoint, framework-agnostic),
`validate.js` (allow-list validation), `format.js` (per-channel rendering),
`whatsapp.js`, `email.js`, `crm.js`, `ratelimit.js`, `config.js`.

---

## Running it

```sh
cp .env.example .env          # fill in the values
node --env-file=.env server.js
#  page → http://localhost:3000
#  API  → POST http://localhost:3000/api/lead
```

Without a `.env`, the page still works end to end: unconfigured channels are
reported as *skipped*, not *failed*, so the form submits and confirms normally.

```sh
npm test
```

The page must be served over HTTP — opening the `.dc.html` from `file://` will
not work, because `support.js` needs a real origin. `support.js` loads React
18.3.1 from unpkg and the page loads Newsreader / Plus Jakarta Sans from Google
Fonts, so the first render needs network access to `unpkg.com` and
`fonts.googleapis.com`.

---

## Lead capture

The form collects: full name, WhatsApp number, email, country of residence,
**cité** (Cœur Joie or Bethel), **villa type** (F4 / Duplex / Autre), the
specific villa, project timeframe, budget, and a free-text message.

Two fields are filled in without the prospect touching them:

- **Submission date** — set server-side. A client-supplied timestamp is not
  evidence, so it is ignored.
- **Acquisition source** — resolved by `assets/tracking.js` from UTM tags, then
  ad click IDs (`gclid`, `fbclid`, `ttclid`), then the referrer host: Google,
  Facebook, Instagram, TikTok, YouTube, LinkedIn, WhatsApp, or Direct. Kept in
  `sessionStorage`, so a prospect who arrives from TikTok and later reloads the
  page directly is still attributed to TikTok.

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

## Known limitations

- **The page has no `<title>`.** It comes from the design that way. Worth
  adding before launch for SEO and browser tabs.
- **A `404` for `{{ v.image }}` appears once in the console.** Chromium's
  preload scanner requests the literal template attribute before the runtime
  hydrates. Cosmetic, and inherent to how `dc-runtime` pages boot.

# GCITT — Cité Cœur Joie

Landing page for GCITT BENIN SA, presenting the Cité Cœur Joie and Cité Bethel
villa developments in Abomey-Calavi, Benin.

Imported from the Claude Design project
`GCITT - Cite Coeur Joie`.

## Files

| Path | Role |
| --- | --- |
| `GCITT - Cite Coeur Joie.dc.html` | The page. Template markup plus the `DCLogic` component that drives it. |
| `support.js` | The `dc-runtime` that parses `<x-dc>`, binds `{{ … }}` expressions and mounts the component with React. |
| `uploads/` | Photography and the GCITT logo. |

## Running it

The page is static — serve the directory over HTTP and open the `.dc.html`:

```sh
python3 -m http.server 8000
# http://localhost:8000/GCITT%20-%20Cite%20Coeur%20Joie.dc.html
```

Opening it straight off the filesystem (`file://`) will not work: `support.js`
fetches the template from the document and needs a real origin.

`support.js` pulls React 18.3.1 and ReactDOM from unpkg at runtime, and the page
loads Newsreader and Plus Jakarta Sans from Google Fonts, so the first render
needs network access to `unpkg.com` and `fonts.googleapis.com`.

## Structure

Eleven sections, in order: nav, hero, pain points, projection, villas (Cœur Joie
and Bethel), why GCITT, client journey, trust/testimonials, FAQ, appointment
form, closing, footer.

The villa cards and FAQ entries are data-driven — they live in `renderVals()` at
the bottom of the `.dc.html`, alongside the prices, spec lists and answer copy.
Edit them there rather than in the markup.

The appointment form is currently client-side only: submitting it flips the
panel to a confirmation state, offers an `.ics` download and a WhatsApp
hand-off. `buildNotificationPayload()` assembles the lead object that a backend
is expected to consume (internal email, WhatsApp Business notification, CRM),
but nothing is wired to it yet.

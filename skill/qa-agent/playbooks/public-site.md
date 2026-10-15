# Playbook: public site audit

For marketing sites, docs, blogs: anything reachable without logging in.

## Run

```
node <skillDir>/scripts/site-audit.js <start-url> --out <runDir>/audit --max 40
```

Options: `--max N` pages to crawl (default 40), `--no-external` skip external link checks, `--timeout ms`, `--concurrency N`. A 25-page, 400-link site takes about 45 seconds. Output: `findings.json` (schema: `../schemas/finding.schema.json`), `crawl.json`, `summary.md`.

It checks: broken pages and links (internal and external), redirect chains, sitemap entries, titles and meta descriptions (presence, length, duplicates), canonical, `noindex`, Open Graph, JSON-LD validity, `<h1>` and heading order, `<main>`, `lang`, viewport zoom, image alt, link and button names, iframe titles, form-control labels, positive `tabindex`, mixed content, HTML size, slow responses, and security headers on the start page.

## Verify before reporting

The script is static, so confirm before you report:

- **label / link-name / button-name:** open the markup (`curl -s <url>`) and look at the element. Icon-only links with `aria-hidden` SVGs and no text are real findings.
- **link-broken (external):** re-check with `curl -s -o /dev/null -w '%{http_code}' -L -A 'Mozilla/5.0' <url>`. Some sites block bots (403, 429, 999); the script already skips those, but confirm any 404 on a site that might geo-block.
- **client-rendered pages:** nothing below the head was checked. Use a browser if you have one, otherwise list the page under `blocked`.
- **heading-order, seo-title-length, og tags:** low value; report as minor and group them.

## Grouping for reporting

One Jira issue per rule per group of pages, not per page. Example: "[QA] Form controls without accessible labels on 5 pages" with the pages listed. The fingerprint of a group is the fingerprint of its first (alphabetically) page; keep the others in the description.

Good candidates to file as separate issues: anything critical or serious, any `link-broken` that points at your own origin, and `seo-noindex`. Roll moderate and minor findings into one weekly-style rollup issue.

## Compare with the last run

If the task mentions "regressions", search Jira by `qa-fp-` labels (see `reporting.md`). A finding with an existing open issue is "seen again", not new; a Done issue whose finding returned is a regression (reopen it).

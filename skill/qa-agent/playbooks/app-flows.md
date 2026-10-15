# Playbook: the app (behind a login), AI output, API, billing

This is the most sensitive area. Default to **read-only** and test accounts. If you are not given a way in, test only what is public and say so under `blocked`.

## Getting in

- Login may be email one-time-code. **Never** try to read someone's inbox or guess codes.
- Use only what the task or project context provides: a saved browser session (Playwright `storageState`), a test account whose code you were told how to obtain, or an API key in an environment variable.
- Interactive tasks: ask the human to log in in the browser you are driving, then continue.
- Unattended with no access: audit the unauthenticated surface only (login page accessibility and SEO, redirects, security headers, public API docs) and record the rest as `blocked`.

## Tooling

Use a browser tool if one is available (Playwright MCP or a built-in browser): navigate, read the accessibility tree, take screenshots into `<runDir>`. Otherwise use `curl` for API and static checks. The app is a client-rendered SPA, so `site-audit.js` will report `client-rendered` for its pages.

## What to check

**Shell and auth:** unauthenticated routes redirect to login and return to the right page afterwards; logout and expired sessions behave; keyboard-only use works; WCAG basics on every screen (labels, names, focus visible, contrast where measurable); loading, empty and error states.

**AI output quality** (when the app produces model-generated results and a golden set is provided in the project documents, as JSON lines of `{"input": "...", "expected": "..."}`):
- Score with the tolerance that fits the output (exact match, category match, or a tolerance stated in the task). Report the match rate per level.
- Run each input once; re-run a sample of 5 three times to measure drift.
- Check any explanation the app gives: present, consistent with the output, and any citations or links resolve.
- Adversarial inputs: empty, over the length cap, non-English, prompt-injection text ("ignore previous instructions"), multi-part input, nonsense. Nonsense must be refused or flagged, not answered with confidence.
- Runs may spend credits. Respect the budget in the prompt; stop and report when it is reached.

**API and bulk upload:** contract checks against the published OpenAPI spec (status codes, error shapes, auth required, rate limits); upload fixtures with malformed CSV or XLSX, duplicate rows, odd encodings, and cells that start with `=`, `+`, `-` or `@` (formula injection) and confirm they are neutralised in exports.

**Tenant isolation:** only with two test tenants provided. Try to read tenant A's objects with tenant B's token. Any success is **critical**; do not post details to Slack, only "critical isolation finding, see Jira" with a link.

**Billing:** Stripe **test mode only**, test card numbers only. If anything shows a live key or a real card form that is not in test mode, stop and report. Never complete a real payment.

## Reporting notes

- Mark functional and AI-output findings with category `functional` or `ai-output`.
- Evidence must be reproducible: the exact input, the expected value, the observed value, and the run folder path of any screenshot.
- Do not put customer data, tokens or one-time codes in Jira or Slack.

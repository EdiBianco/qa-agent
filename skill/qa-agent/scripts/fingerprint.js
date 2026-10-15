#!/usr/bin/env node
// Prints the de-duplication fingerprint used for Jira labels: qa-fp-<10 hex>.
// Usage: node fingerprint.js <rule-id> <url-or-path> <element-tag> [--origin https://site.example]
//   hash = first 10 hex of sha256("<rule-id>|<url path without query>|<element tag>"), lowercased.
//   For URLs on a different host than --origin, the host is included before the path.
const crypto = require('crypto');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const oi = process.argv.indexOf('--origin');
const origin = oi >= 0 ? process.argv[oi + 1] : null;
const [rule, target, tag = 'page'] = args;
if (!rule || !target) { console.error('Usage: node fingerprint.js <rule-id> <url-or-path> <element-tag> [--origin <origin>]'); process.exit(2); }
let where = target;
try {
  const u = new URL(target, origin || 'http://local.invalid');
  where = origin && u.origin !== new URL(origin).origin ? `${u.host}${u.pathname}` : u.pathname;
} catch { /* keep as given */ }
const hash = crypto.createHash('sha256').update(`${rule}|${where}|${tag}`.toLowerCase()).digest('hex').slice(0, 10);
console.log(`qa-fp-${hash}`);

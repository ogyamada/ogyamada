// Refreshes the live sections of README.md: contribution stats, recent public
// activity and latest blog posts. Runs hourly from .github/workflows/profile.yml.
import { readFile, writeFile } from 'node:fs/promises';

const USER = process.env.PROFILE_USER || 'ogyamada';
const FEED = process.env.PROFILE_FEED || 'https://yuuiichi.com/rss.xml';
const README = process.env.README_PATH || 'README.md';
const TOKEN = process.env.GITHUB_TOKEN;

const gh = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER, ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};

const fmt = (n) => n.toLocaleString('en-US');
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const repoLink = (name) => `[${name}](https://github.com/${name})`;

async function stats() {
  const query = `query($login: String!) { user(login: $login) { contributionsCollection { contributionCalendar {
    totalContributions weeks { contributionDays { date contributionCount } } } } } }`;
  const { data } = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { login: USER } }) });
  const cal = data.user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  const active = days.filter((d) => d.contributionCount > 0).length;

  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today may still be empty early in the day; don't let that break the streak.
  let i = days.length - 1;
  if (days[i]?.contributionCount === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].contributionCount > 0) {
    current++;
    i--;
  }

  return [
    '<table align="center"><tr>',
    `<td align="center"><b>${fmt(cal.totalContributions)}</b><br><sub>contributions · last year</sub></td>`,
    `<td align="center"><b>${current} days</b><br><sub>current streak</sub></td>`,
    `<td align="center"><b>${longest} days</b><br><sub>longest streak</sub></td>`,
    `<td align="center"><b>${active} / ${days.length}</b><br><sub>active days</sub></td>`,
    '</tr></table>',
  ].join('\n');
}

function describe(e) {
  const repo = repoLink(e.repo.name);
  const p = e.payload ?? {};
  switch (e.type) {
    case 'PushEvent': {
      const n = p.size ?? p.commits?.length ?? 0;
      return n ? `Pushed ${n} commit${n === 1 ? '' : 's'} to ${repo}` : `Pushed to ${repo}`;
    }
    case 'PullRequestEvent': {
      const pr = p.pull_request;
      const link = `[#${pr.number}](${pr.html_url})`;
      if (p.action === 'closed' && pr.merged) return `Merged ${link} in ${repo}`;
      if (p.action === 'opened') return `Opened ${link} in ${repo}`;
      return null;
    }
    case 'PullRequestReviewEvent':
      return `Reviewed [#${p.pull_request.number}](${p.pull_request.html_url}) in ${repo}`;
    case 'IssuesEvent':
      return p.action === 'opened' ? `Opened issue [#${p.issue.number}](${p.issue.html_url}) in ${repo}` : null;
    case 'ReleaseEvent':
      return p.action === 'published' ? `Released [${p.release.tag_name}](${p.release.html_url}) of ${repo}` : null;
    case 'CreateEvent':
      return p.ref_type === 'repository' ? `Created ${repo}` : null;
    case 'PublicEvent':
      return `Open-sourced ${repo}`;
    case 'WatchEvent':
      return `Starred ${repo}`;
    case 'ForkEvent':
      return `Forked ${repo}`;
    default:
      return null;
  }
}

async function activity() {
  const events = await gh(`/users/${USER}/events/public?per_page=100`);
  const lines = [];
  const seen = new Set();
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    // Collapse repeated pushes to the same repo on the same day into one line.
    const key = `${day(e.created_at)}|${e.type === 'PushEvent' ? `push:${e.repo.name}` : text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- \`${day(e.created_at)}\` ${text}`);
    if (lines.length === 8) break;
  }
  if (!lines.length) return '_Quiet on public repos right now. Most work happens in private ones._';
  return lines.join('\n');
}

async function writing() {
  const res = await fetch(FEED, { headers: { 'User-Agent': USER } });
  if (!res.ok) throw new Error(`${FEED} → ${res.status}`);
  const xml = await res.text();
  const clean = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map(([, item]) => {
    const title = clean(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = clean(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '');
    const date = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    return `- [${title}](${link})${date ? ` · <sub>${day(date)}</sub>` : ''}`;
  });
  return items.length ? items.join('\n') : '_First posts are on the way._';
}

function replace(md, name, body) {
  const re = new RegExp(`(<!--${name}:START-->)[\\s\\S]*?(<!--${name}:END-->)`);
  return re.test(md) ? md.replace(re, `$1\n${body}\n$2`) : md;
}

const before = await readFile(README, 'utf8');
let after = before;
for (const [name, fn] of [['STATS', stats], ['ACTIVITY', activity], ['WRITING', writing]]) {
  try {
    after = replace(after, name, await fn());
  } catch (err) {
    // Keep the previous content if a source is down.
    console.warn(`${name} skipped: ${err.message}`);
  }
}

if (after !== before) {
  await writeFile(README, after);
  console.log('README updated');
} else {
  console.log('No changes');
}

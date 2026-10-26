// Release notes for a version: every change on main since the previous release, linked to
// its pull request or commit. A merged PR is one line, whatever it had inside.
//   bun scripts/release-notes.ts v1.2.3
// Notes run up to the v1.2.3 tag when it exists (filling in an old release), otherwise HEAD.
import { $ } from "bun";

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+/.test(tag ?? "")) {
  console.error("Usage: bun scripts/release-notes.ts v1.2.3");
  process.exit(1);
}

const repo =
  process.env.GITHUB_REPOSITORY ??
  (await $`git remote get-url origin`.text())
    .trim()
    .replace(/^.*github\.com[:/]/, "")
    .replace(/\.git$/, "");
const url = `https://github.com/${repo}`;

// passed as a value so the shell doesn't treat v* as a file glob
const tags = (await $`git tag --list ${"v*"} --sort=-v:refname`.text())
  .split("\n")
  .map(t => t.trim())
  .filter(Boolean);
const end = tags.includes(tag) ? tag : "HEAD";
// the newest release before this one that's actually in this version's history
let prev: string | undefined;
for (const t of tags.filter(t => t !== tag))
  if (
    (await $`git merge-base --is-ancestor ${t} ${end}`.nothrow()).exitCode === 0
  ) {
    prev = t;
    break;
  }

async function commits(range: string) {
  const raw =
    await $`git log --first-parent --format=%H%x1f%s%x1f%b%x1e ${range}`.text();
  return raw
    .split("\x1e")
    .map(r => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map(r => {
      const [sha, subject, body] = r.split("\x1f");
      return { sha, subject, body: body ?? "" };
    });
}

const skip = (line: string) =>
  !line.trim() ||
  /^(release v|co-authored-by|signed-off-by|merge (branch|pull request))|generated with/i.test(
    line.trim()
  );
const tidy = (line: string) => {
  const s = line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/\s*\(#\d+\)$/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
// plain "#1" and short hashes rather than markdown links: GitHub links them on the release
// page by itself, and Shears' update window (older builds too) shows them as clean text
const commitLink = (sha: string) => sha.slice(0, 7);
const prLink = (n: string) => `#${n}`;

const lines: string[] = [];
// only main's own line of history: a merged PR counts once, not once per commit inside it
for (const c of await commits(prev ? `${prev}..${end}` : end)) {
  // "Merge pull request #1 ..." (title in the body) or "Title (#1)"
  const merged = /^Merge pull request #(\d+)/.exec(c.subject);
  const pr = merged?.[1] ?? /\(#(\d+)\)$/.exec(c.subject)?.[1];
  if (pr) {
    const title = merged
      ? (c.body.split("\n").find(l => l.trim()) ?? `Pull request #${pr}`)
      : c.subject;
    lines.push(`- ${tidy(title)} (${prLink(pr)})`);
  } else if (!skip(c.subject))
    lines.push(`- ${tidy(c.subject)} (${commitLink(c.sha)})`);
}

console.log(`## What's new

${lines.length ? lines.join("\n") : "- Fixes and small improvements"}
${prev ? `\n**Full changelog**: ${url}/compare/${prev}...${tag}\n` : ""}
Download **Shears_*_x64-setup.exe** below. Shears updates itself from here on.`);

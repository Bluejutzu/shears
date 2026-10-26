// Release notes for a version: every change on main since the previous release, linked to
// its pull request or commit. A merged PR is one line with its own commits listed under it.
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

type Commit = { sha: string; parents: string[]; subject: string; body: string };

async function commits(range: string, extra: string[] = []) {
  const raw =
    await $`git log ${extra} --format=%H%x1f%P%x1f%s%x1f%b%x1e ${range}`.text();
  return raw
    .split("\x1e")
    .map(r => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map(r => {
      const [sha, parents, subject, body] = r.split("\x1f");
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        subject,
        body: body ?? "",
      } as Commit;
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
const commitLink = (sha: string) =>
  `[${sha.slice(0, 7)}](${url}/commit/${sha})`;
const prLink = (n: string) => `[#${n}](${url}/pull/${n})`;

/** A PR's own commits, from GitHub (they aren't in main's history after a squash). */
async function prCommits(n: string) {
  const res = await $`gh api ${`repos/${repo}/pulls/${n}/commits`} --paginate`
    .nothrow()
    .quiet();
  if (res.exitCode !== 0) return null;
  const list = JSON.parse(res.stdout.toString()) as {
    sha: string;
    commit: { message: string };
  }[];
  return list.map(c => ({
    sha: c.sha,
    subject: c.commit.message.split("\n")[0],
  }));
}

const lines: string[] = [];
for (const c of await commits(prev ? `${prev}..${end}` : end, [
  "--first-parent",
])) {
  // "Merge pull request #1 ..." (title in the body) or "Title (#1)"
  const merged = /^Merge pull request #(\d+)/.exec(c.subject);
  const pr = merged?.[1] ?? /\(#(\d+)\)$/.exec(c.subject)?.[1];
  if (!pr) {
    if (!skip(c.subject))
      lines.push(`- ${tidy(c.subject)} (${commitLink(c.sha)})`);
    continue;
  }
  const title = merged
    ? (c.body.split("\n").find(l => l.trim()) ?? `Pull request #${pr}`)
    : c.subject;
  lines.push(`- ${tidy(title)} (${prLink(pr)})`);
  // --first-parent hides a merge's other parent from %P, so ask for them directly
  const parents = (await $`git rev-parse ${`${c.sha}^@`}`.text())
    .split("\n")
    .filter(Boolean);
  const subs =
    parents.length > 1
      ? (await commits(`${parents[0]}..${parents[1]}`, ["--no-merges"])).map(
          s => ({
            subject: s.subject,
            link: commitLink(s.sha),
          })
        )
      : ((await prCommits(pr))?.map(s => ({
          subject: s.subject,
          link: `[${s.sha.slice(0, 7)}](${url}/pull/${pr}/commits/${s.sha})`,
        })) ??
        // no GitHub access: use the commit list GitHub writes into a squash message
        c.body
          .split("\n")
          .filter(l => /^\s*[-*]\s/.test(l))
          .map(l => ({ subject: l, link: "" })));
  for (const s of subs)
    if (!skip(s.subject))
      lines.push(`  - ${tidy(s.subject)}${s.link ? ` (${s.link})` : ""}`);
}

console.log(`## What's new

${lines.length ? lines.join("\n") : "- Fixes and small improvements"}
${prev ? `\n**Full changelog**: [${prev}...${tag}](${url}/compare/${prev}...${tag})\n` : ""}
Download **Shears_*_x64-setup.exe** below. Shears updates itself from here on.`);

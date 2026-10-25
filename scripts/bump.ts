// Sets the app version everywhere it lives: package.json (which tauri.conf.json reads),
// Cargo.toml and Cargo.lock.
//   bun run bump patch | minor | major | 1.2.3
import { readFileSync, writeFileSync } from "node:fs";

const arg = process.argv[2];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = String(pkg.version).split(".").map(Number);

const next =
  arg === "major"
    ? `${major + 1}.0.0`
    : arg === "minor"
      ? `${major}.${minor + 1}.0`
      : arg === "patch"
        ? `${major}.${minor}.${patch + 1}`
        : arg;

if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error("Usage: bun run bump patch | minor | major | <x.y.z>");
  process.exit(1);
}

const swap = (file: string, pattern: RegExp, replacement: string) => {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`No version found in ${file}`);
  writeFileSync(file, text.replace(pattern, replacement));
};

pkg.version = next;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
swap("src-tauri/Cargo.toml", /^version = ".*"$/m, `version = "${next}"`);
swap(
  "src-tauri/Cargo.lock",
  /(name = "shears"\r?\nversion = )".*"/,
  `$1"${next}"`
);

console.log(`Version is now ${next}. To release it:
  git commit -am "release v${next}"
  git tag v${next}
  git push && git push --tags`);

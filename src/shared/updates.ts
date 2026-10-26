import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { CircleArrowUp } from "lucide";

import { saveSettings, store } from "./settings";
import { fmtSize, h, icon, modal, progressBar, toast } from "./ui";

let checking = false;
let pill: HTMLElement | null = null;
/** saves edits and settings before the installer closes the app */
let beforeInstall: () => Promise<void> = async () => {};

export function setBeforeInstall(fn: () => Promise<void>) {
  beforeInstall = fn;
}

/**
 * Look for a new version. A quiet check (on startup) only speaks up when there is one,
 * and then just with a pill in the title bar.
 */
export async function checkForUpdates(quiet = false) {
  const prefs = store.settings.updates;
  if (store.app.channel !== "release") {
    if (!quiet)
      toast("Updates are off in dev builds", {
        body: "Local builds (Shears Dev) don't update themselves. The public release updates from GitHub.",
      });
    return;
  }
  if (checking) return;
  checking = true;
  try {
    const update = await check();
    prefs.lastCheck = Date.now();
    saveSettings();
    if (!update) {
      if (!quiet)
        toast("You're up to date", {
          body: `Shears ${store.app.version} is the latest version.`,
        });
      return;
    }
    if (quiet && prefs.skipped === update.version) return;
    showPill(update);
    if (!quiet) showUpdate(update);
  } catch (err) {
    if (!quiet)
      toast("Couldn't check for updates", { body: String(err), error: true });
  } finally {
    checking = false;
  }
}

/** One quiet check a few seconds after startup, at most every 6 hours. */
export function autoCheck() {
  const prefs = store.settings.updates;
  if (!prefs.auto || store.app.channel !== "release") return;
  if (Date.now() - prefs.lastCheck < 6 * 3600_000) return;
  setTimeout(() => checkForUpdates(true), 4000);
}

function showPill(update: Update) {
  pill?.remove();
  pill = h(
    "button",
    {
      class: "update-pill",
      "data-tip": `Shears ${update.version} is ready to install`,
      "data-tip-pos": "below",
      onclick: () => showUpdate(update),
    },
    icon(CircleArrowUp, 15),
    "Update"
  );
  document.querySelector(".win-controls")?.before(pill);
}

/** Release notes are markdown; show headings, bullets and paragraphs without pulling in a parser. */
function notes(text: string) {
  const el = h("div", { class: "update-notes" });
  let list: HTMLElement | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet) {
      list ??= el.appendChild(h("ul"));
      list.append(h("li", {}, bullet[1].replace(/\*\*/g, "")));
      continue;
    }
    list = null;
    if (!line) continue;
    const head = /^#{1,6}\s+(.*)/.exec(line);
    el.append(
      head
        ? h("div", { class: "update-notes-head" }, head[1])
        : h("p", {}, line.replace(/\*\*/g, ""))
    );
  }
  if (!el.childNodes.length)
    el.append(h("p", { class: "dim" }, "No release notes for this version."));
  return el;
}

function showUpdate(update: Update) {
  const body = h("div", { class: "update" });
  const { close } = modal("Update available", body);
  const date = update.date ? new Date(update.date.replace(" ", "T")) : null;

  body.append(
    h(
      "div",
      { class: "update-head" },
      h("div", { class: "update-version" }, `Shears ${update.version}`),
      h(
        "div",
        { class: "dim" },
        `You have ${store.app.version}${date && !isNaN(+date) ? ` · released ${date.toLocaleDateString()}` : ""}`
      )
    ),
    notes(update.body ?? ""),
    h(
      "div",
      { class: "modal-foot" },
      h(
        "button",
        {
          class: "btn btn-ghost",
          onclick: () => {
            store.settings.updates.skipped = update.version;
            saveSettings();
            pill?.remove();
            close();
          },
        },
        "Skip this version"
      ),
      h(
        "button",
        { class: "btn btn-secondary", onclick: () => close() },
        "Later"
      ),
      h(
        "button",
        { class: "btn btn-primary", onclick: () => install(update, body) },
        "Install and restart"
      )
    )
  );
}

async function install(update: Update, body: HTMLElement) {
  const status = h("span", {}, "Getting ready…");
  const pct = h("span", { class: "progress-pct" });
  const bar = progressBar();
  body.replaceChildren(
    h(
      "div",
      { class: "export-progress" },
      h("div", { class: "progress-head" }, status, pct),
      bar.el,
      h(
        "div",
        { class: "progress-meta" },
        h("span", { class: "dim" }, `Shears ${update.version}`),
        h("span", { class: "dim" }, "Shears restarts when it's done")
      )
    )
  );
  const show = (p: number) => {
    bar.set(p);
    pct.textContent = `${Math.round(p * 100)}%`;
  };

  try {
    await beforeInstall();
    let total = 0;
    let got = 0;
    await update.downloadAndInstall(e => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        status.textContent = total
          ? `Downloading · ${fmtSize(got)} of ${fmtSize(total)}`
          : `Downloading · ${fmtSize(got)}`;
        if (total) show(got / total);
      } else if (e.event === "Finished") {
        show(1);
        status.textContent = "Installing…";
      }
    });
    await relaunch();
  } catch (err) {
    status.textContent = "The update didn't go through";
    toast("Couldn't install the update", { body: String(err), error: true });
  }
}

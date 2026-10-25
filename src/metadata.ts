import {
  CalendarClock,
  FileText,
  MapPin,
  Plus,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Tags,
  X,
  type IconNode,
} from "lucide";

import { api, type MetaEdit } from "./api";
import type { Edit } from "./edit";
import { basename, ext, h, icon, modal, toast, toggle } from "./ui";

/** A field in the dialog and the tag names it can be stored under (first one wins when reading). */
type Field = {
  id: string;
  label: string;
  keys: string[];
  multiline?: boolean;
  placeholder?: string;
};

const ABOUT: Field[] = [
  { id: "title", label: "Title", keys: ["title", "com.apple.quicktime.title"] },
  {
    id: "artist",
    label: "Artist",
    keys: ["artist", "author", "com.apple.quicktime.author"],
  },
  { id: "album", label: "Album / series", keys: ["album", "show"] },
  { id: "genre", label: "Genre", keys: ["genre", "com.apple.quicktime.genre"] },
  {
    id: "description",
    label: "Description",
    keys: ["description", "synopsis", "com.apple.quicktime.description"],
    multiline: true,
  },
  {
    id: "comment",
    label: "Comment",
    keys: ["comment", "com.apple.quicktime.comment"],
    multiline: true,
  },
  {
    id: "keywords",
    label: "Keywords",
    keys: ["keywords", "com.apple.quicktime.keywords"],
    placeholder: "comma, separated",
  },
  {
    id: "copyright",
    label: "Copyright",
    keys: ["copyright", "com.apple.quicktime.copyright"],
  },
];

const DATE: Field = {
  id: "date",
  label: "Recorded",
  keys: ["creation_time", "com.apple.quicktime.creationdate", "date"],
};
const LOCATION: Field = {
  id: "location",
  label: "Location",
  keys: ["com.apple.quicktime.location.ISO6709", "location"],
};
const MAKE: Field = {
  id: "make",
  label: "Make",
  keys: ["com.apple.quicktime.make", "make", "com.android.manufacturer"],
  placeholder: "Apple",
};
const MODEL: Field = {
  id: "model",
  label: "Model",
  keys: ["com.apple.quicktime.model", "model", "com.android.model"],
  placeholder: "iPhone 16 Pro",
};
const SOFTWARE: Field = {
  id: "software",
  label: "Software",
  keys: ["com.apple.quicktime.software", "software", "com.android.version"],
  placeholder: "18.0",
};

const FIELDS = [...ABOUT, DATE, LOCATION, MAKE, MODEL, SOFTWARE];
// written by the muxer or describing the container: shown, not editable
const TECHNICAL = [
  "major_brand",
  "minor_version",
  "compatible_brands",
  "encoder",
  "location-eng",
];

const lower = (s: string) => s.toLowerCase();

/** Where a field gets written when the file doesn't have it yet. */
function defaultKey(f: Field, container: string) {
  const mov = ["mp4", "mov", "m4v"].includes(container);
  // plain make/model/software only survive in .mov; mp4 needs the Apple-style keys
  if (["make", "model", "software"].includes(f.id))
    return container === "mov" ? f.id : mov ? f.keys[0] : f.id;
  if (f.id === "location") return "location";
  if (f.id === "date") return "creation_time";
  return f.keys.find(k => !k.includes(".")) ?? f.keys[0];
}

// ---- location: ISO 6709 strings like "+52.5200+013.4050+034.000/"

type Place = { lat: number; lon: number; alt: number | null };

function parsePlace(s: string): Place | null {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(
    s.trim()
  );
  if (!m) return null;
  return { lat: +m[1], lon: +m[2], alt: m[3] ? +m[3] : null };
}

function formatPlace(p: Place) {
  const sign = (v: number) => (v < 0 ? "-" : "+");
  const num = (v: number, int: number) => {
    const [a, b] = Math.abs(v).toFixed(4).split(".");
    return `${a.padStart(int, "0")}.${b}`;
  };
  return `${sign(p.lat)}${num(p.lat, 2)}${sign(p.lon)}${num(p.lon, 3)}${p.alt != null ? `${sign(p.alt)}${Math.abs(p.alt).toFixed(3)}` : ""}/`;
}

/** "52.52, 13.405" or "52.52 13.405", like what maps apps copy. */
function parseLatLon(s: string): Place | null {
  const m = /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(s);
  if (!m) return parsePlace(s);
  const lat = +m[1];
  const lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? { lat, lon, alt: null }
    : null;
}

const placeLabel = (p: Place) =>
  `${Math.abs(p.lat).toFixed(4)}° ${p.lat < 0 ? "S" : "N"}, ${Math.abs(p.lon).toFixed(4)}° ${p.lon < 0 ? "W" : "E"}`;

// ---- dates: creation_time is UTC ("...Z"); Apple's creationdate keeps the local offset

const pad = (n: number) => String(n).padStart(2, "0");

function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateFor(key: string, d: Date) {
  if (!key.endsWith("creationdate"))
    return d.toISOString().replace(/\.\d+Z$/, ".000000Z");
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  return `${toLocalInput(d)}${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

function parseDate(s: string) {
  if (/^\d{4}$/.test(s.trim())) return new Date(+s, 0, 1);
  // "+0200" offsets need a colon for Date to read them
  const d = new Date(s.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return isNaN(+d) ? null : d;
}

// ---- dialog: a list of sections on the left, the chosen one on the right

type Section = "about" | "date" | "location" | "device" | "tags" | "privacy";
let lastSection: Section = "about";

export function openMetadata(opts: {
  path: string;
  edit: Edit;
  /** write the tags into the file (or a copy); resolves once it's done */
  write: (edit: MetaEdit, output: string | null) => Promise<boolean>;
}) {
  const { path, edit: e } = opts;
  const container = ext(path);
  let orig: Record<string, string> = {};
  let loaded = false;
  let busy = false;
  let newKey = "";
  let newValue = "";
  let section = lastSection;

  // which tag names a field lives under in this file (matching names case-insensitively, mkv shouts)
  const keysOf = (f: Field) => {
    const have = Object.keys(orig).filter(k =>
      f.keys.map(lower).includes(lower(k))
    );
    return have.length ? have : [defaultKey(f, container)];
  };
  const original = (f: Field) => {
    for (const k of f.keys) {
      const hit = Object.keys(orig).find(o => lower(o) === lower(k));
      if (hit) return orig[hit];
    }
    return "";
  };
  const value = (f: Field) => {
    for (const k of keysOf(f))
      if (k in e.meta.tags) return e.meta.tags[k] ?? "";
    return original(f);
  };
  const edited = (f: Field) => keysOf(f).some(k => k in e.meta.tags);
  /** Set a field on every tag it lives under; going back to the original undoes the change. */
  const set = (f: Field, v: string | ((key: string) => string)) => {
    const patch: Record<string, string | null | undefined> = {};
    for (const k of keysOf(f)) {
      const next = typeof v === "function" ? v(k) : v.trim();
      const was = orig[k] ?? "";
      patch[k] = next === was ? undefined : next || (was ? null : undefined);
    }
    e.setTags(patch);
  };
  const reset = (f: Field) =>
    e.setTags(Object.fromEntries(keysOf(f).map(k => [k, undefined])));

  const otherKeys = () => {
    const known = new Set(FIELDS.flatMap(f => f.keys).map(lower));
    return [...new Set([...Object.keys(orig), ...Object.keys(e.meta.tags)])]
      .filter(k => !known.has(lower(k)) && !TECHNICAL.includes(lower(k)))
      .sort();
  };

  const body = h("div", { class: "meta" });
  const { close } = modal("Metadata", body, { wide: true });
  body.closest(".modal")?.classList.add("meta-modal");
  const prevChange = e.onChange;
  let pending = 0;
  e.onChange = () => {
    prevChange();
    // re-render after focus has moved on (a change fires as you tab out), then put focus back
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      if (!body.isConnected) return;
      const f = (document.activeElement as HTMLElement | null)?.dataset?.f;
      render();
      if (f) body.querySelector<HTMLElement>(`[data-f="${f}"]`)?.focus();
    }, 0);
  };
  // put the editor's own change handler back once the dialog is gone
  const watch = new MutationObserver(() => {
    if (!body.isConnected) {
      e.onChange = prevChange;
      watch.disconnect();
    }
  });
  watch.observe(document.body, { childList: true });

  const resetBtn = (f: Field) =>
    edited(f)
      ? h(
          "button",
          {
            class: "icon-btn sm meta-reset",
            "data-tip": "Undo this change",
            onclick: () => reset(f),
          },
          icon(RotateCcw, 13)
        )
      : null;

  const input = (f: Field) => {
    const attrs = {
      class: `input${f.multiline ? " meta-area" : ""}`,
      "data-f": f.id,
      placeholder: f.placeholder ?? "",
      spellcheck: "false",
      onchange: (ev: Event) => set(f, (ev.target as HTMLInputElement).value),
    };
    const el = f.multiline
      ? (h("textarea", { ...attrs, rows: "3" }) as HTMLTextAreaElement)
      : (h("input", attrs) as HTMLInputElement);
    el.value = value(f);
    return h(
      "label",
      {
        class: `meta-field${f.multiline ? " wide" : ""}${edited(f) ? " edited" : ""}`,
      },
      h("span", { class: "meta-label" }, f.label, resetBtn(f)),
      el
    );
  };

  // ---- what each section shows

  const date = () => parseDate(value(DATE));
  const place = () => parsePlace(value(LOCATION));
  const device = () =>
    [value(MAKE), value(MODEL)].filter(Boolean).join(" ") || "";

  const sections: {
    id: Section;
    icon: IconNode;
    label: string;
    summary: () => string;
    changed: () => boolean;
  }[] = [
    {
      id: "about",
      icon: FileText,
      label: "About",
      summary: () => value(ABOUT[0]) || "No title",
      changed: () => ABOUT.some(edited),
    },
    {
      id: "date",
      icon: CalendarClock,
      label: "Recorded",
      summary: () =>
        date()?.toLocaleDateString(undefined, { dateStyle: "medium" }) ??
        "Not set",
      changed: () => edited(DATE),
    },
    {
      id: "location",
      icon: MapPin,
      label: "Location",
      summary: () => {
        const p = place();
        return p ? placeLabel(p) : "Not set";
      },
      changed: () => edited(LOCATION),
    },
    {
      id: "device",
      icon: Smartphone,
      label: "Device",
      summary: () => device() || "Unknown",
      changed: () => [MAKE, MODEL, SOFTWARE].some(edited),
    },
    {
      id: "tags",
      icon: Tags,
      label: "All tags",
      summary: () => {
        const n = otherKeys().length;
        return n ? `${n} more ${n === 1 ? "tag" : "tags"}` : "Add your own";
      },
      changed: () => otherKeys().some(k => k in e.meta.tags),
    },
    {
      id: "privacy",
      icon: ShieldCheck,
      label: "Privacy",
      summary: () => (e.meta.strip ? "Stripped on export" : "Tags kept"),
      changed: () => e.meta.strip,
    },
  ];

  const hero = (title: string, sub: string, now?: string) =>
    h(
      "div",
      { class: "meta-hero" },
      h(
        "div",
        { class: "meta-hero-text" },
        h("div", { class: "meta-hero-title" }, title),
        h("div", { class: "meta-hero-sub" }, sub),
        now ? h("div", { class: "meta-hero-now" }, now) : null
      )
    );

  function aboutView() {
    return [
      hero("About", "What players and file browsers show for this clip."),
      h("div", { class: "meta-grid" }, ...ABOUT.map(input)),
    ];
  }

  function dateView() {
    const d = date();
    return [
      hero(
        "Recorded",
        "When it was filmed. Photo apps sort by this.",
        d
          ? d.toLocaleString(undefined, {
              dateStyle: "full",
              timeStyle: "short",
            })
          : undefined
      ),
      h(
        "label",
        { class: `meta-field${edited(DATE) ? " edited" : ""}` },
        h("span", { class: "meta-label" }, "Date and time", resetBtn(DATE)),
        h("input", {
          class: "input",
          type: "datetime-local",
          step: "1",
          "data-f": "date",
          value: d ? toLocalInput(d) : "",
          onchange: (ev: Event) => {
            const v = (ev.target as HTMLInputElement).value;
            if (!v) return set(DATE, "");
            const nd = new Date(v);
            set(DATE, key => dateFor(key, nd));
          },
        })
      ),
      h(
        "div",
        { class: "meta-actions" },
        h(
          "button",
          {
            class: "btn btn-secondary btn-sm",
            onclick: () => {
              const now = new Date();
              set(DATE, key => dateFor(key, now));
            },
          },
          "Set to now"
        ),
        d &&
          h(
            "button",
            { class: "btn btn-ghost btn-sm", onclick: () => set(DATE, "") },
            "Remove date"
          )
      ),
    ];
  }

  function locationView() {
    const p = place();
    const coord = (
      label: string,
      v: number | null | undefined,
      key: "lat" | "lon" | "alt"
    ) =>
      h(
        "label",
        { class: "meta-field" },
        h("span", { class: "meta-label" }, label),
        h("input", {
          class: "input",
          type: "number",
          "data-f": key,
          step: key === "alt" ? "1" : "0.0001",
          value: v == null ? "" : String(v),
          placeholder: key === "alt" ? "Optional" : "0",
          onchange: (ev: Event) => {
            const n = parseFloat((ev.target as HTMLInputElement).value);
            const next: Place = {
              lat: p?.lat ?? 0,
              lon: p?.lon ?? 0,
              alt: p?.alt ?? null,
            };
            if (key === "alt") next.alt = isFinite(n) ? n : null;
            else if (isFinite(n))
              next[key] = Math.max(
                key === "lat" ? -90 : -180,
                Math.min(key === "lat" ? 90 : 180, n)
              );
            set(LOCATION, formatPlace(next));
          },
        })
      );
    return [
      hero(
        "Location",
        "Where it was filmed. Phones save this automatically.",
        p
          ? `${placeLabel(p)}${p.alt != null ? ` · ${Math.round(p.alt)} m up` : ""}`
          : undefined
      ),
      h(
        "div",
        { class: `meta-row3${edited(LOCATION) ? " edited" : ""}` },
        coord("Latitude", p?.lat, "lat"),
        coord("Longitude", p?.lon, "lon"),
        coord("Altitude (m)", p?.alt, "alt")
      ),
      h(
        "label",
        { class: "meta-field" },
        h("span", { class: "meta-label" }, "Paste coordinates"),
        h("input", {
          class: "input",
          placeholder: "52.52, 13.405",
          onchange: (ev: Event) => {
            const el = ev.target as HTMLInputElement;
            const parsed = parseLatLon(el.value);
            if (parsed) set(LOCATION, formatPlace(parsed));
            else toast("Couldn't read those coordinates", { body: el.value });
          },
        })
      ),
      h(
        "div",
        { class: "meta-actions" },
        edited(LOCATION) &&
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: () => reset(LOCATION),
            },
            "Undo"
          ),
        p &&
          h(
            "button",
            { class: "btn btn-ghost btn-sm", onclick: () => set(LOCATION, "") },
            "Remove location"
          )
      ),
    ];
  }

  function deviceView() {
    return [
      hero(
        "Device",
        "The camera or phone it came from.",
        device() || undefined
      ),
      h(
        "div",
        { class: "meta-grid" },
        input(MAKE),
        input(MODEL),
        input(SOFTWARE)
      ),
    ];
  }

  function tagsView() {
    const keys = otherKeys();
    const tech = Object.keys(orig).filter(k => TECHNICAL.includes(lower(k)));
    return [
      hero(
        "All tags",
        "Everything else stored in the file. Edit, remove or add your own."
      ),
      h(
        "div",
        { class: "meta-tags" },
        ...keys.map(k => {
          const v = k in e.meta.tags ? e.meta.tags[k] : orig[k];
          const removed = v === null;
          return h(
            "div",
            {
              class: `meta-tag${k in e.meta.tags ? " edited" : ""}${removed ? " removed" : ""}`,
            },
            h("span", { class: "meta-key", title: k }, k),
            h("input", {
              class: "input input-sm",
              value: v ?? "",
              disabled: removed,
              onchange: (ev: Event) => {
                const nv = (ev.target as HTMLInputElement).value;
                e.setTags({
                  [k]: nv === (orig[k] ?? "") ? undefined : nv || null,
                });
              },
            }),
            h(
              "button",
              {
                class: "icon-btn sm",
                "data-tip": k in e.meta.tags ? "Undo" : "Remove tag",
                onclick: () =>
                  e.setTags({ [k]: k in e.meta.tags ? undefined : null }),
              },
              icon(k in e.meta.tags ? RotateCcw : X, 13)
            )
          );
        }),
        h(
          "div",
          { class: "meta-tag add" },
          h("input", {
            class: "input input-sm meta-key-input",
            placeholder: "tag name",
            value: newKey,
            oninput: (ev: Event) =>
              (newKey = (ev.target as HTMLInputElement).value),
          }),
          h("input", {
            class: "input input-sm",
            placeholder: "value",
            value: newValue,
            oninput: (ev: Event) =>
              (newValue = (ev.target as HTMLInputElement).value),
          }),
          h(
            "button",
            {
              class: "icon-btn sm",
              "data-tip": "Add tag",
              onclick: () => {
                const k = newKey.trim();
                const v = newValue.trim();
                if (!k || !v) return;
                newKey = newValue = "";
                e.setTags({ [k]: v });
              },
            },
            icon(Plus, 14)
          )
        )
      ),
      tech.length > 0 &&
        h(
          "div",
          { class: "meta-tech" },
          h("div", { class: "meta-label" }, "Written by the container"),
          ...tech.map(k => h("span", {}, h("b", {}, k), orig[k]))
        ),
    ];
  }

  function privacyView() {
    const hasPrivate = !!(
      value(LOCATION) ||
      value(MAKE) ||
      value(MODEL) ||
      value(SOFTWARE)
    );
    return [
      hero(
        "Privacy",
        "Clips from phones carry where and on what they were filmed."
      ),
      h(
        "div",
        { class: "meta-option" },
        h(
          "div",
          {},
          h("div", {}, "Strip all metadata on export"),
          h(
            "div",
            { class: "meta-hint" },
            "Exports leave out every tag, location and date included. The original file isn't touched."
          )
        ),
        toggle(e.meta.strip, v => e.setStrip(v))
      ),
      h(
        "div",
        { class: "meta-option" },
        h(
          "div",
          {},
          h("div", {}, "Remove location and device"),
          h(
            "div",
            { class: "meta-hint" },
            hasPrivate
              ? "Clears where it was filmed and the phone it came from, keeping the rest."
              : "There's no location or device info in this clip."
          )
        ),
        h(
          "button",
          {
            class: "btn btn-secondary btn-sm",
            disabled: !hasPrivate,
            onclick: () => {
              const patch: Record<string, string | null | undefined> = {};
              for (const f of [LOCATION, MAKE, MODEL, SOFTWARE])
                for (const k of keysOf(f))
                  patch[k] = orig[k] ? null : undefined;
              e.setTags(patch);
            },
          },
          "Remove"
        )
      ),
    ];
  }

  const views: Record<Section, () => (Node | false | null)[]> = {
    about: aboutView,
    date: dateView,
    location: locationView,
    device: deviceView,
    tags: tagsView,
    privacy: privacyView,
  };

  function render() {
    const changes = Object.keys(e.meta.tags).length;
    const detail = body.querySelector(".meta-detail");
    const scroll = detail?.scrollTop ?? 0;
    const nav = h(
      "nav",
      { class: "meta-nav" },
      ...sections.map(s =>
        h(
          "button",
          {
            class: `meta-nav-item${s.id === section ? " active" : ""}`,
            onclick: () => {
              if (section === s.id) return;
              section = lastSection = s.id;
              render();
              body.querySelector(".meta-detail")?.scrollTo(0, 0);
            },
          },
          icon(s.icon, 18),
          h(
            "span",
            { class: "meta-nav-text" },
            h("span", { class: "meta-nav-label" }, s.label),
            h("span", { class: "meta-nav-sum" }, loaded ? s.summary() : "…")
          ),
          s.changed()
            ? h("span", { class: "meta-dot", "data-tip": "Changed" })
            : null
        )
      )
    );
    const pane = h(
      "div",
      { class: "meta-detail", "data-section": section },
      ...(loaded
        ? views[section]()
        : [h("div", { class: "meta-loading" }, "Reading tags…")])
    );
    body.replaceChildren(
      h("div", { class: "meta-body" }, nav, pane),
      h(
        "div",
        { class: "modal-foot meta-foot" },
        h(
          "div",
          { class: "meta-status" },
          e.meta.strip
            ? "Exports will leave out all metadata."
            : changes
              ? `${changes} ${changes === 1 ? "change" : "changes"}, used when you export`
              : `${basename(path)} · nothing changed`
        ),
        changes > 0 &&
          h(
            "button",
            { class: "btn btn-ghost", onclick: () => e.clearTags() },
            "Undo all"
          ),
        h(
          "button",
          {
            class: "btn btn-secondary",
            disabled: busy || (!changes && !e.meta.strip),
            "data-tip":
              "Rewrites the original file with these tags. Video and audio aren't touched.",
            onclick: async () => {
              busy = true;
              render();
              const done = await opts.write(e.metaEdit(), null);
              busy = false;
              if (done) {
                orig = await api.readTags(path).catch(() => orig);
                e.clearTags();
                if (e.meta.strip) e.setStrip(false);
              }
              render();
            },
          },
          busy ? "Writing…" : "Write into file"
        ),
        h(
          "button",
          { class: "btn btn-primary", onclick: () => close() },
          "Done"
        )
      )
    );
    const d = body.querySelector(".meta-detail");
    if (d) d.scrollTop = scroll;
  }

  render();
  api
    .readTags(path)
    .then(t => (orig = t))
    .catch(() => {})
    .finally(() => {
      loaded = true;
      render();
    });
}

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

// ---- illustrations: all CSS-drawn so they follow the theme

function calendar(d: Date | null) {
  const el = h("div", { class: `ill-cal${d ? "" : " empty"}` });
  const month = d ? d.toLocaleString(undefined, { month: "short" }) : "—";
  const hr = d ? (d.getHours() % 12) * 30 + d.getMinutes() / 2 : 0;
  const min = d ? d.getMinutes() * 6 : 0;
  el.append(
    h(
      "div",
      { class: "ill-cal-page" },
      h("div", { class: "ill-cal-month" }, month.toUpperCase()),
      h("div", { class: "ill-cal-day" }, d ? String(d.getDate()) : "?"),
      h(
        "div",
        { class: "ill-cal-year" },
        d ? String(d.getFullYear()) : "No date"
      )
    ),
    h(
      "div",
      { class: "ill-clock" },
      h("i", { class: "hand hr", style: `--a:${hr}deg` }),
      h("i", { class: "hand min", style: `--a:${min}deg` }),
      h("i", { class: "hand sec" }),
      h("b")
    )
  );
  return el;
}

// the streets drift with the coordinates so different places look different
const drift = (p: Place | null) =>
  p
    ? `translate(${(((p.lon * 37) % 120) - 60) * 0.4}px, ${(((p.lat * 53) % 120) - 60) * 0.3}px) scale(1.25)`
    : "scale(1.25)";

function map(p: Place | null, from: Place | null) {
  const el = h("div", { class: `ill-map${p ? "" : " empty"}` });
  el.innerHTML = `
    <svg class="ill-map-streets" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice" style="transform: ${drift(from ?? p)}">
      <path class="water" d="M-20 210 C 80 170, 140 260, 240 220 S 400 150, 500 190 L 500 320 L -20 320 Z"/>
      <rect class="park" x="300" y="40" width="90" height="60" rx="10"/>
      <rect class="park" x="40" y="70" width="60" height="44" rx="8"/>
      <g class="roads">
        <path d="M0 60 H480 M0 130 H480 M120 0 V300 M250 0 V300 M380 0 V300"/>
        <path class="major" d="M-10 300 L 200 90 L 480 30"/>
      </g>
      <g class="lanes"><path d="M0 95 H480 M60 0 V300 M190 0 V300 M320 0 V300 M440 0 V300 M0 165 H480"/></g>
    </svg>
    <div class="ill-pin-wrap"><span class="ill-pin-pulse"></span>
      <svg class="ill-pin" viewBox="0 0 24 32"><path d="M12 31s10-11.2 10-19A10 10 0 0 0 2 12c0 7.8 10 19 10 19z"/><circle cx="12" cy="12" r="4"/></svg>
    </div>`;
  el.append(
    h("div", { class: "ill-map-label" }, p ? placeLabel(p) : "No location")
  );
  // pan over from the old spot to the new one
  if (from) {
    const svg = el.querySelector<SVGElement>("svg")!;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => (svg.style.transform = drift(p)))
    );
  }
  return el;
}

function camera(make: string, model: string) {
  const known = !!(make || model);
  const iphone = /iphone/i.test(model) || (/apple/i.test(make) && !model);
  const lens = (cls: string) =>
    h("div", { class: `ill-lens ${cls}` }, h("i"), h("b"));
  const body = iphone
    ? h(
        "div",
        { class: "ill-bump" },
        lens("l1"),
        lens("l2"),
        lens("l3"),
        h("span", { class: "ill-flash" }),
        h("span", { class: "ill-lidar" }),
        h("span", { class: "ill-mic" })
      )
    : h(
        "div",
        { class: "ill-bump single" },
        lens("solo"),
        h("span", { class: "ill-flash" })
      );
  return h(
    "div",
    { class: `ill-device${known ? "" : " empty"}` },
    body,
    h(
      "div",
      { class: "ill-device-label" },
      known ? [make, model].filter(Boolean).join(" · ") : "No device info"
    )
  );
}

// ---- dialog

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
  let intro = true;

  // illustrations are kept between renders and only rebuilt when what they show changes,
  // so their animations play on a change and the looping ones don't restart on every edit
  const ills = new Map<string, { key: string; el: HTMLElement }>();
  const memo = (
    id: string,
    key: string,
    make: (prevKey: string | null) => HTMLElement
  ) => {
    const hit = ills.get(id);
    if (hit?.key === key) return hit.el;
    const el = make(hit?.key ?? null);
    if (hit) el.classList.add("changed");
    ills.set(id, { key, el });
    return el;
  };

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

  const card = (
    ic: IconNode,
    title: string,
    sub: string,
    ...children: (Node | null | false)[]
  ) =>
    h(
      "section",
      { class: "meta-card" },
      h(
        "div",
        { class: "meta-card-head" },
        h("span", { class: "meta-chip" }, icon(ic, 16)),
        h(
          "div",
          {},
          h("div", { class: "meta-card-title" }, title),
          h("div", { class: "meta-card-sub" }, sub)
        )
      ),
      ...children
    );

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
      ? (h("textarea", { ...attrs, rows: "2" }) as HTMLTextAreaElement)
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

  function aboutCard() {
    return card(
      FileText,
      "About",
      "What players and file browsers show",
      h("div", { class: "meta-grid" }, ...ABOUT.map(input))
    );
  }

  function dateCard() {
    const d = parseDate(value(DATE));
    const field = h("input", {
      class: "input",
      type: "datetime-local",
      step: "1",
      value: d ? toLocalInput(d) : "",
      onchange: (ev: Event) => {
        const v = (ev.target as HTMLInputElement).value;
        if (!v) return set(DATE, "");
        const nd = new Date(v);
        set(DATE, key => dateFor(key, nd));
      },
    });
    return card(
      CalendarClock,
      "Recorded",
      d ? d.toLocaleString() : "When it was filmed",
      h(
        "div",
        { class: "meta-split" },
        memo("cal", d ? String(+d) : "", () => calendar(d)),
        h(
          "div",
          { class: "meta-stack" },
          h(
            "label",
            { class: `meta-field${edited(DATE) ? " edited" : ""}` },
            h("span", { class: "meta-label" }, "Date and time", resetBtn(DATE)),
            field
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
              "Now"
            ),
            d &&
              h(
                "button",
                { class: "btn btn-ghost btn-sm", onclick: () => set(DATE, "") },
                "Remove"
              )
          )
        )
      )
    );
  }

  function locationCard() {
    const p = parsePlace(value(LOCATION));
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
          step: key === "alt" ? "1" : "0.0001",
          value: v == null ? "" : String(v),
          placeholder: key === "alt" ? "optional" : "0",
          onchange: (ev: Event) => {
            const n = parseFloat((ev.target as HTMLInputElement).value);
            const next: Place = {
              lat: p?.lat ?? 0,
              lon: p?.lon ?? 0,
              alt: p?.alt ?? null,
            };
            if (key === "alt") next.alt = isFinite(n) ? n : null;
            else if (isFinite(n))
              next[key] =
                key === "lat"
                  ? Math.max(-90, Math.min(90, n))
                  : Math.max(-180, Math.min(180, n));
            set(LOCATION, formatPlace(next));
          },
        })
      );
    return card(
      MapPin,
      "Location",
      p ? "Where it was filmed" : "Not set",
      memo("map", value(LOCATION), prev =>
        map(p, prev ? parsePlace(prev) : null)
      ),
      h(
        "div",
        { class: "meta-row3" },
        coord("Latitude", p?.lat, "lat"),
        coord("Longitude", p?.lon, "lon"),
        coord("Altitude (m)", p?.alt, "alt")
      ),
      h(
        "div",
        { class: "meta-actions" },
        h("input", {
          class: "input input-sm",
          placeholder: "Paste coordinates, e.g. 52.52, 13.405",
          onchange: (ev: Event) => {
            const el = ev.target as HTMLInputElement;
            const place = parseLatLon(el.value);
            if (place) set(LOCATION, formatPlace(place));
            else toast("Couldn't read those coordinates", { body: el.value });
          },
        }),
        edited(LOCATION) &&
          h(
            "button",
            { class: "btn btn-ghost btn-sm", onclick: () => reset(LOCATION) },
            "Undo"
          ),
        p &&
          h(
            "button",
            { class: "btn btn-ghost btn-sm", onclick: () => set(LOCATION, "") },
            "Remove"
          )
      )
    );
  }

  function deviceCard() {
    return card(
      Smartphone,
      "Device",
      "The camera or phone it came from",
      h(
        "div",
        { class: "meta-split" },
        memo("cam", `${value(MAKE)}|${value(MODEL)}`, () =>
          camera(value(MAKE), value(MODEL))
        ),
        h(
          "div",
          { class: "meta-stack" },
          input(MAKE),
          input(MODEL),
          input(SOFTWARE)
        )
      )
    );
  }

  function privacyCard() {
    const hasPrivate = !!(
      value(LOCATION) ||
      value(MAKE) ||
      value(MODEL) ||
      value(SOFTWARE)
    );
    return card(
      ShieldCheck,
      "Privacy",
      "Before sharing a clip",
      h(
        "div",
        { class: "meta-inline" },
        h(
          "div",
          {},
          h("div", {}, "Strip all metadata on export"),
          h(
            "div",
            { class: "meta-card-sub" },
            "Exports leave out every tag, location included."
          )
        ),
        toggle(e.meta.strip, v => e.setStrip(v))
      ),
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm btn-block",
          disabled: !hasPrivate,
          onclick: () => {
            const patch: Record<string, string | null | undefined> = {};
            for (const f of [LOCATION, MAKE, MODEL, SOFTWARE])
              for (const k of keysOf(f)) patch[k] = orig[k] ? null : undefined;
            e.setTags(patch);
          },
        },
        "Remove location and device"
      )
    );
  }

  function otherCard() {
    const known = new Set(FIELDS.flatMap(f => f.keys).map(lower));
    const keys = [
      ...new Set([...Object.keys(orig), ...Object.keys(e.meta.tags)]),
    ]
      .filter(k => !known.has(lower(k)) && !TECHNICAL.includes(lower(k)))
      .sort();
    const tech = Object.keys(orig).filter(k => TECHNICAL.includes(lower(k)));
    return card(
      Tags,
      "All other tags",
      keys.length
        ? `${keys.length} more in this file`
        : "Add any tag the container supports",
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
        ),
        tech.length > 0 &&
          h(
            "div",
            { class: "meta-tech" },
            ...tech.map(k => h("span", {}, h("b", {}, k), orig[k]))
          )
      )
    );
  }

  function render() {
    const changes = Object.keys(e.meta.tags).length;
    const scroll = body.querySelector(".meta-scroll")?.scrollTop ?? 0;
    body.replaceChildren(
      h(
        "div",
        { class: "meta-scroll" },
        !loaded
          ? h("div", { class: "meta-loading" }, "Reading tags…")
          : h(
              "div",
              { class: `meta-cols${intro ? " intro" : ""}` },
              h("div", { class: "meta-col" }, aboutCard(), otherCard()),
              h(
                "div",
                { class: "meta-col" },
                dateCard(),
                locationCard(),
                deviceCard(),
                privacyCard()
              )
            )
      ),
      h(
        "div",
        { class: "modal-foot meta-foot" },
        h(
          "div",
          { class: "meta-status" },
          e.meta.strip
            ? "Exports will leave out all metadata."
            : changes
              ? `${changes} ${changes === 1 ? "change" : "changes"} · saved with this clip and used when you export`
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
    const sc = body.querySelector(".meta-scroll");
    if (sc) sc.scrollTop = scroll;
    // the cards only slide in the first time
    if (loaded) intro = false;
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

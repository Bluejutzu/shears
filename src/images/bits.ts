import { Search as SearchIcon, type IconNode } from "lucide";

import { h, icon, modal } from "../ui";

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with the searched words wrapped in <mark>. */
export function marked(text: string, query: string): (string | Node)[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [text];
  const re = new RegExp(words.map(escape).join("|"), "gi");
  const out: (string | Node)[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index), h("mark", {}, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** A small yes/no dialog. `run` returning false keeps it open. */
export function ask(
  title: string,
  body: Node,
  ok: string,
  run: () => boolean | void,
  danger = false
) {
  const { close } = modal(
    title,
    h(
      "div",
      { class: "form" },
      body,
      h(
        "div",
        { class: "modal-foot" },
        h(
          "button",
          { class: "btn btn-ghost", onclick: () => close() },
          "Cancel"
        ),
        h(
          "button",
          {
            class: `btn ${danger ? "btn-danger" : "btn-primary"}`,
            onclick: () => {
              if (run() !== false) close();
            },
          },
          ok
        )
      )
    )
  );
}

export const tipBtn = (
  ic: IconNode,
  tip: string,
  run: () => void,
  opts: { key?: string; on?: boolean; off?: boolean; below?: boolean } = {}
) =>
  h(
    "button",
    {
      class: `icon-btn sm${opts.on ? " on" : ""}`,
      "data-tip": tip,
      "data-key": opts.key ?? null,
      "data-tip-pos": opts.below ? "below" : null,
      "aria-label": tip,
      disabled: opts.off,
      onclick: run,
    },
    icon(ic, 16)
  );

export const searchBox = (
  value: string,
  placeholder: string,
  set: (v: string) => void,
  id?: string
) =>
  h(
    "label",
    { class: "search-box" },
    icon(SearchIcon, 15),
    h("input", {
      class: "input",
      id: id ?? null,
      placeholder,
      spellcheck: "false",
      value,
      oninput: (e: Event) => set((e.target as HTMLInputElement).value),
    })
  );

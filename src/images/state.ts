import type { ImageEditor } from "./editor";
import type { FlowHost } from "./flow";
import type { Filter } from "./library";

export type View = "library" | "convert" | "send" | "editor";

/** What the image app needs from the rest of Shears. */
export type ImagesHost = FlowHost & {
  /** the app name, tools and settings strip at the bottom of the sidebar */
  footer: () => HTMLElement;
  showSettings: () => void;
  showShortcuts: () => void;
};

/** Everything the image app's pages share. */
export const st = {
  active: false,
  view: "library" as View,
  editor: null as ImageEditor | null,
  /** the open picture's library entry (id is null until it's saved) */
  cur: {
    id: null as string | null,
    name: "Untitled",
    category: "",
    tags: [] as string[],
  },
  filter: { q: "", category: null, sort: "new" } as Filter,
  picked: new Set<string>(),
  lastPicked: null as string | null,
};

let hostRef: ImagesHost | null = null;
export const host = () => hostRef!;
export const setHost = (h: ImagesHost) => (hostRef = h);

/** Redraw hooks, filled in by index.ts so pages don't import each other in circles. */
export const redraw = {
  all: () => {},
  sidebar: () => {},
  main: () => {},
  chrome: () => {},
  go: (_view: View) => {},
};

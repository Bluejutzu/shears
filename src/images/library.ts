import { api, fileUrl } from "../shared/api";
import { join } from "../shared/ui";
import type { Doc } from "./doc";

export type ImageItem = {
  id: string;
  name: string;
  /** "" = uncategorized */
  category: string;
  tags: string[];
  w: number;
  h: number;
  created: number;
  updated: number;
};

export type Sort = "new" | "name" | "size";

let items: ImageItem[] = [];
let dir = "";
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

export const onLibrary = (fn: () => void) => listeners.add(fn);
const notify = () => listeners.forEach(fn => fn());

export function loadLibrary() {
  loaded ??= api
    .imagesLoad()
    .then(r => {
      dir = r.dir;
      const saved = (r.index as { items?: ImageItem[] }).items;
      items = Array.isArray(saved) ? saved : [];
      notify();
    })
    .catch(() => {});
  return loaded;
}

const saveIndex = () => api.imagesSaveIndex({ items }).catch(() => {});

export const libraryDir = () => dir;
export const allItems = () => items;
export const itemById = (id: string) => items.find(i => i.id === id);
export const pathOf = (id: string) => join(dir, `${id}.png`);
/** the picture's URL, changing whenever it's saved again so it never shows a stale copy */
export const thumbUrl = (i: ImageItem) =>
  `${fileUrl(pathOf(i.id))}?v=${i.updated}`;

export function categories() {
  const counts = new Map<string, number>();
  for (const i of items)
    if (i.category) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

export type Filter = { q: string; category: string | null; sort: Sort };

/** `category`: null shows everything, "" only the uncategorized ones. Every word in `q` has to match. */
export function filtered(f: Filter) {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = items.filter(i => {
    if (f.category !== null && i.category !== f.category) return false;
    const text = `${i.name} ${i.category} ${i.tags.join(" ")}`.toLowerCase();
    return words.every(w => text.includes(w));
  });
  if (f.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  else if (f.sort === "size") list.sort((a, b) => b.w * b.h - a.w * a.h);
  else list.sort((a, b) => b.updated - a.updated);
  return list;
}

export const newItemId = () =>
  `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Write the picture and its editable layers, and add or refresh its entry in the index. */
export async function saveItem(
  meta: Pick<ImageItem, "id" | "name" | "category" | "tags" | "w" | "h">,
  png: Uint8Array,
  doc: Doc
) {
  const file = await api.imageWrite(meta.id, png);
  // the tags go into the library copy too, so converting it later keeps them
  const tags = Object.entries(doc.meta?.tags ?? {}).filter(([, v]) => v);
  if (tags.length && !doc.meta?.strip)
    await api.imageTagsWrite(file, { strip: false, tags }).catch(() => {});
  await api.imageDocWrite(meta.id, doc);
  const now = Date.now();
  const at = items.findIndex(i => i.id === meta.id);
  const item: ImageItem = {
    ...meta,
    created: at >= 0 ? items[at].created : now,
    updated: now,
  };
  if (at >= 0) items[at] = item;
  else items.push(item);
  await saveIndex();
  notify();
  return item;
}

export function updateItems(ids: string[], patch: Partial<ImageItem>) {
  for (const i of items) if (ids.includes(i.id)) Object.assign(i, patch);
  saveIndex();
  notify();
}

export async function removeItems(ids: string[]) {
  items = items.filter(i => !ids.includes(i.id));
  await Promise.all(ids.map(id => api.imageDelete(id).catch(() => {})));
  await saveIndex();
  notify();
}

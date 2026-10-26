import { newLayer, SIZES, type Bg, type Doc } from "./doc";

export type Template = {
  id: string;
  label: string;
  hint: string;
  make: () => Doc;
};

const blank = (size: string, bg: Bg = null): Doc => ({
  w: SIZES[size].w,
  h: SIZES[size].h,
  bg,
  layers: [],
});

export const GRADIENTS: { label: string; bg: Bg }[] = [
  { label: "Dusk", bg: { from: "#3b1f6b", to: "#e0567a", angle: 135 } },
  { label: "Ocean", bg: { from: "#0f3b6e", to: "#33c4d1", angle: 160 } },
  { label: "Forest", bg: { from: "#12372a", to: "#6dbf74", angle: 150 } },
  { label: "Sunset", bg: { from: "#ff7e5f", to: "#feb47b", angle: 120 } },
  { label: "Slate", bg: { from: "#1c1f26", to: "#3c4452", angle: 180 } },
  { label: "Mint", bg: { from: "#a8edea", to: "#fed6e3", angle: 135 } },
];

/** Starting points for common overlays; each one is ordinary layers you can change. */
export const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    hint: "Transparent canvas",
    make: () => blank("video"),
  },
  {
    id: "lower-third",
    label: "Lower third",
    hint: "Name bar for the bottom of the frame",
    make: () => {
      const d = blank("video");
      d.layers.push(
        newLayer("rect", {
          name: "Bar",
          x: 560,
          y: 900,
          w: 820,
          h: 150,
          radius: 18,
          fill: "#101318",
          opacity: 0.88,
        }),
        newLayer("rect", {
          name: "Accent",
          x: 168,
          y: 900,
          w: 12,
          h: 110,
          radius: 6,
          fill: "#7aa7ff",
        }),
        newLayer("text", {
          name: "Name",
          text: "Your name",
          x: 520,
          y: 880,
          size: 54,
          fill: "#ffffff",
          w: 330,
          h: 65,
        }),
        newLayer("text", {
          name: "Title",
          text: "What you do",
          x: 497,
          y: 938,
          size: 32,
          bold: false,
          fill: "#aab4c5",
          w: 290,
          h: 40,
        })
      );
      return d;
    },
  },
  {
    id: "title-card",
    label: "Title card",
    hint: "Big centered title on a gradient",
    make: () => {
      const d = blank("video", GRADIENTS[0].bg);
      d.layers.push(
        newLayer("text", {
          name: "Title",
          text: "Your title",
          x: 960,
          y: 520,
          size: 150,
          align: "center",
          fill: "#ffffff",
          w: 700,
          h: 180,
        }),
        newLayer("rect", {
          name: "Underline",
          x: 960,
          y: 640,
          w: 260,
          h: 10,
          radius: 5,
          fill: "#ffffff",
          opacity: 0.8,
        })
      );
      return d;
    },
  },
  {
    id: "corner-badge",
    label: "Corner badge",
    hint: "Small logo or label in a corner",
    make: () => {
      const d = blank("video");
      d.layers.push(
        newLayer("rect", {
          name: "Badge",
          x: 1700,
          y: 110,
          w: 340,
          h: 100,
          radius: 50,
          fill: "#e0405a",
        }),
        newLayer("text", {
          name: "Label",
          text: "LIVE",
          x: 1700,
          y: 108,
          size: 48,
          align: "center",
          fill: "#ffffff",
          w: 120,
          h: 58,
        })
      );
      return d;
    },
  },
  {
    id: "callout",
    label: "Callout",
    hint: "Arrow pointing at something",
    make: () => {
      const d = blank("video");
      d.layers.push(
        newLayer("arrow", {
          name: "Arrow",
          x: 960,
          y: 540,
          w: 360,
          h: 220,
          stroke: "#ffd23f",
          sw: 12,
        }),
        newLayer("text", {
          name: "Note",
          text: "Look here",
          x: 700,
          y: 380,
          size: 64,
          fill: "#ffd23f",
          w: 260,
          h: 78,
        })
      );
      return d;
    },
  },
  {
    id: "frame",
    label: "Frame",
    hint: "Border around the whole picture",
    make: () => {
      const d = blank("video");
      d.layers.push(
        newLayer("rect", {
          name: "Border",
          x: 960,
          y: 540,
          w: 1860,
          h: 1020,
          radius: 28,
          stroke: "#ffffff",
          sw: 14,
        })
      );
      return d;
    },
  },
];

export const BACKGROUNDS: { label: string; bg: Bg }[] = [
  { label: "Transparent", bg: null },
  { label: "White", bg: "#ffffff" },
  { label: "Black", bg: "#000000" },
  { label: "Green screen", bg: "#00b140" },
  ...GRADIENTS,
];

export function blankDoc(size: string, bg: Bg) {
  return blank(size in SIZES ? size : "video", bg);
}

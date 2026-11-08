import type { UnitTypeId } from '@sc/core';

/**
 * Unit silhouettes, drawn in a [-1, 1] box (the caller translates and scales).
 * Land vehicles and ships are seen from the side, aircraft from above, so the
 * domain reads at a glance even before the counter's shape.
 */
type Painter = (c: CanvasRenderingContext2D) => void;

const poly = (c: CanvasRenderingContext2D, pts: number[]) => {
  c.beginPath();
  c.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i]!, pts[i + 1]!);
  c.closePath();
  c.fill();
};
const rect = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => c.fillRect(x, y, w, h);
const disc = (c: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
};
const wheels = (c: CanvasRenderingContext2D, xs: number[], y: number, r: number) => xs.forEach((x) => disc(c, x, y, r));
const track = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  c.beginPath();
  c.roundRect(x, y, w, h, h / 2);
  c.fill();
};

const PAINTERS: Record<UnitTypeId, Painter> = {
  infantry: (c) => {
    disc(c, 0, -0.5, 0.17); // head
    c.beginPath();
    c.ellipse(0, -0.56, 0.27, 0.17, 0, Math.PI, 0); // helmet
    c.fill();
    poly(c, [-0.36, 0.1, -0.3, -0.26, 0.3, -0.26, 0.36, 0.1]); // torso
    rect(c, -0.26, 0.1, 0.2, 0.62); // legs
    rect(c, 0.06, 0.1, 0.2, 0.62);
    c.save();
    c.lineWidth = 0.12;
    c.beginPath();
    c.moveTo(-0.62, 0.18);
    c.lineTo(0.66, -0.62); // rifle across the chest
    c.stroke();
    c.restore();
  },
  mech_infantry: (c) => {
    poly(c, [-0.7, 0.2, -0.6, -0.25, 0.45, -0.25, 0.72, 0.05, 0.72, 0.2]);
    rect(c, -0.2, -0.42, 0.3, 0.17);
    wheels(c, [-0.45, 0, 0.45], 0.33, 0.14);
  },
  heavy_tank: (c) => {
    track(c, -0.78, 0.12, 1.56, 0.36);
    poly(c, [-0.66, 0.12, -0.56, -0.12, 0.6, -0.12, 0.7, 0.12]);
    poly(c, [-0.32, -0.12, -0.24, -0.4, 0.22, -0.4, 0.3, -0.12]); // turret
    rect(c, 0.2, -0.32, 0.66, 0.08); // gun
  },
  artillery: (c) => {
    track(c, -0.7, 0.18, 1.2, 0.3);
    poly(c, [-0.6, 0.18, -0.5, -0.08, 0.3, -0.08, 0.4, 0.18]);
    c.save();
    c.translate(-0.05, -0.1);
    c.rotate(-0.55);
    rect(c, 0, -0.06, 0.95, 0.12); // long barrel
    c.restore();
  },
  anti_air: (c) => {
    poly(c, [-0.7, 0.2, -0.6, -0.08, 0.6, -0.08, 0.7, 0.2]);
    wheels(c, [-0.45, 0.45], 0.3, 0.14);
    c.save();
    c.translate(0, -0.12);
    for (const dx of [-0.1, 0.1]) {
      c.save();
      c.translate(dx, 0);
      c.rotate(-1.05);
      rect(c, 0, -0.04, 0.75, 0.08);
      c.restore();
    }
    c.restore();
  },
  recon: (c) => {
    poly(c, [-0.72, 0.18, -0.68, -0.12, -0.2, -0.14, 0.05, -0.38, 0.4, -0.38, 0.55, -0.12, 0.74, -0.08, 0.74, 0.18]);
    wheels(c, [-0.42, 0.42], 0.25, 0.17);
  },
  transport: (c) => {
    poly(c, [-0.85, -0.05, 0.85, -0.05, 0.62, 0.32, -0.7, 0.32]); // hull
    rect(c, -0.55, -0.32, 0.9, 0.27); // cargo box
    rect(c, 0.42, -0.45, 0.2, 0.4); // bridge
  },
  corvette: (c) => {
    poly(c, [-0.8, 0.0, 0.85, 0.0, 0.6, 0.26, -0.65, 0.26]);
    poly(c, [-0.2, 0, -0.1, -0.28, 0.2, -0.28, 0.3, 0]);
  },
  destroyer: (c) => {
    poly(c, [-0.9, 0.0, 0.95, -0.04, 0.62, 0.26, -0.72, 0.26]);
    poly(c, [-0.35, 0, -0.25, -0.3, 0.15, -0.3, 0.25, 0]);
    rect(c, -0.05, -0.5, 0.06, 0.22); // mast
    rect(c, 0.4, -0.12, 0.35, 0.06); // gun
  },
  missile_cruiser: (c) => {
    poly(c, [-0.92, 0.0, 0.95, -0.04, 0.65, 0.28, -0.72, 0.28]);
    poly(c, [-0.4, 0, -0.3, -0.34, 0.2, -0.34, 0.3, 0]);
    for (const x of [-0.75, -0.62, 0.45, 0.58]) poly(c, [x, 0, x + 0.04, -0.22, x + 0.08, 0]); // missiles
  },
  submarine: (c) => {
    c.beginPath();
    c.ellipse(0, 0.08, 0.86, 0.2, 0, 0, Math.PI * 2);
    c.fill();
    poly(c, [-0.18, -0.08, -0.1, -0.4, 0.18, -0.4, 0.22, -0.08]); // sail
  },
  battleship: (c) => {
    poly(c, [-0.95, -0.02, 0.98, -0.06, 0.7, 0.3, -0.78, 0.3]);
    poly(c, [-0.3, -0.02, -0.2, -0.36, 0.22, -0.36, 0.32, -0.02]);
    for (const x of [-0.7, 0.45]) {
      rect(c, x, -0.18, 0.22, 0.16); // turrets
      rect(c, x + (x < 0 ? -0.22 : 0.2), -0.13, 0.24, 0.05); // barrels
    }
  },
  carrier: (c) => {
    poly(c, [-0.98, -0.12, 0.98, -0.12, 0.72, 0.3, -0.8, 0.3]); // flat deck
    rect(c, 0.3, -0.42, 0.22, 0.3); // island
  },
  recon_drone: (c) => {
    c.save();
    c.lineWidth = 0.16;
    c.beginPath();
    c.moveTo(-0.6, -0.6);
    c.lineTo(0.6, 0.6);
    c.moveTo(0.6, -0.6);
    c.lineTo(-0.6, 0.6);
    c.stroke();
    c.restore();
    for (const [x, y] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]] as const) disc(c, x, y, 0.2);
    disc(c, 0, 0, 0.2);
  },
  fighter: (c) => {
    poly(c, [0, -0.9, 0.12, -0.3, 0.75, 0.3, 0.75, 0.42, 0.14, 0.3, 0.32, 0.75, 0, 0.62, -0.32, 0.75, -0.14, 0.3, -0.75, 0.42, -0.75, 0.3, -0.12, -0.3]);
  },
  cas: (c) => {
    rect(c, -0.09, -0.85, 0.18, 1.6); // fuselage
    poly(c, [-0.9, -0.12, 0.9, -0.12, 0.9, 0.12, -0.9, 0.12]); // straight wings
    poly(c, [-0.36, 0.6, 0.36, 0.6, 0.36, 0.75, -0.36, 0.75]); // tail
  },
  strategic_bomber: (c) => {
    rect(c, -0.1, -0.9, 0.2, 1.75);
    poly(c, [0, -0.25, 0.95, 0.3, 0.95, 0.45, 0, 0.12, -0.95, 0.45, -0.95, 0.3]); // swept wings
    poly(c, [-0.32, 0.72, 0.32, 0.72, 0.32, 0.85, -0.32, 0.85]);
  },
  awacs: (c) => {
    rect(c, -0.08, -0.85, 0.16, 1.6);
    poly(c, [-0.85, 0.05, 0.85, 0.05, 0.85, 0.2, -0.85, 0.2]);
    c.beginPath();
    c.ellipse(0, -0.25, 0.42, 0.14, 0, 0, Math.PI * 2);
    c.fill(); // radar dome
  },
};

/** Draw a unit's silhouette centered at (x, y), `size` px across, in `color`. */
export function drawUnitIcon(ctx: CanvasRenderingContext2D, type: UnitTypeId, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 2, size / 2);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  PAINTERS[type](ctx);
  ctx.restore();
}

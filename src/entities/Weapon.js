// Weapon.js — weapon definitions + per-weapon runtime state. Two firing models:
// "hitscan" (instant ray, used by ballistic guns) and "projectile" (spawns a
// travelling Projectile, used by the goo/shard guns). All values are tuned for
// an arcade feel; balance lives here so missions stay pure data.

export const WEAPONS = {
  pistol: {
    name: "M7 'Caretaker'", model: 'pistol', mode: 'hitscan',
    damage: 26, headshotMult: 2.4, fireRate: 4.5, auto: false,
    magazine: 12, reserve: 96, reloadTime: 1.1, spread: 0.004, range: 120,
    adsZoom: 2.0, scoped: true, sfx: 'pistol', reticle: 'dot',
  },
  rifle: {
    name: 'AR-22 Bulwark', model: 'rifle', mode: 'hitscan',
    damage: 12, headshotMult: 1.7, fireRate: 11, auto: true,
    magazine: 40, reserve: 240, reloadTime: 1.7, spread: 0.022, range: 90,
    adsZoom: 1.35, sfx: 'rifle', reticle: 'cross',
  },
  goocaster: {
    name: 'Type-G Goocaster', model: 'goocaster', mode: 'projectile', projectile: 'goo',
    damage: 22, shieldMult: 2.2, fireRate: 3, auto: true, splash: 2.2, projectileSpeed: 38,
    magazine: 18, reserve: 90, reloadTime: 1.6, spread: 0.05, range: 50,
    adsZoom: 1.1, sfx: 'goocaster', reticle: 'circle',
    // ADS-fire: a slow, concentrated blast — bigger splash, hammers shields
    alt: { name: 'BLAST', damage: 42, splash: 4.2, shieldMult: 3.2, fireRate: 1.3, projectileSpeed: 30, ammoCost: 2 },
  },
  stinger: {
    name: 'VX-9 Stinger', model: 'stinger', mode: 'projectile', projectile: 'shard',
    damage: 16, homing: true, fireRate: 6, auto: true, projectileSpeed: 44, pellets: 1,
    magazine: 18, reserve: 72, reloadTime: 2.2, spread: 0.06, range: 80,
    adsZoom: 1.2, sfx: 'stinger', reticle: 'circle',
    // ADS-fire: a 3-shard homing volley (costs 3), slower cadence
    alt: { name: 'VOLLEY', burst: 3, fireRate: 2.2, ammoCost: 3 },
  },
  boomstick: {
    name: 'D-12 Boomstick', model: 'boomstick', mode: 'hitscan',
    damage: 13, headshotMult: 1.3, fireRate: 1.4, auto: false, pellets: 9,
    magazine: 2, reserve: 28, reloadTime: 2.0, spread: 0.10, range: 26, knockback: 8,
    adsZoom: 1.05, sfx: 'boomstick', reticle: 'spread',
    // ADS-fire: a tight single slug — high damage, long reach
    alt: { name: 'SLUG', pellets: 1, spread: 0.012, damage: 58, range: 70, fireRate: 1.0, knockback: 14 },
  },
};

export class Weapon {
  constructor(key) {
    this.key = key;
    this.def = WEAPONS[key];
    this.ammo = this.def.magazine;
    this.reserve = this.def.reserve;
    this.cooldown = 0;
    this.reloading = 0;
    this.reloadMult = 1;   // perk: Quick Hands scales this down
  }

  get name() { return this.def.name; }
  get pellets() { return this.def.pellets || 1; }
  canFire() { return this.cooldown <= 0 && this.reloading <= 0 && this.ammo > 0; }
  needsReload() { return this.ammo <= 0; }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this._finishReload();
    }
  }

  startReload() {
    if (this.reloading > 0 || this.ammo >= this.def.magazine || this.reserve <= 0) return false;
    this.reloading = this.def.reloadTime * this.reloadMult;
    return true;
  }

  _finishReload() {
    const need = this.def.magazine - this.ammo;
    const take = Math.min(need, this.reserve);
    this.ammo += take;
    this.reserve -= take;
  }

  consume() {
    this.ammo -= 1;
    this.cooldown = 1 / this.def.fireRate;
  }

  addReserve(amount) {
    this.reserve = Math.min(this.reserve + amount, this.def.reserve * 2);
  }
}

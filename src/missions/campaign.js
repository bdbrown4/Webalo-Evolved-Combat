// campaign.js — the ordered campaign for Webalo: Evolved Combat.
// All content is original. Mission data conforms to ./schema.js and is consumed
// by world/LevelBuilder.js. Progress (highest unlocked mission) persists in
// localStorage so "Continue" works across sessions.

import { normalizeMission } from './schema.js';

const RAW_CAMPAIGN = [
  {
    id: 'm01', name: 'Hard Landing',
    brief: 'The dropship Stalwart Resolve is dead in a smoking crater. Reboot IRIS, dig out of the wreck, and fight through the locals to reach high ground.',
    outro: 'High ground reached. One marine, one cracked AI, and a ring the size of a nightmare. Onward.',
    skybox: 'ring', music: 'ambient',
    palette: { floor: '#5a6e3a', wall: '#3a3026', accent: '#d9622b', fog: '#9bb07a' },
    startWeapons: ['pistol'], finale: false,
    segments: [
      { kind: 'outdoor', size: 'm', objectiveText: 'Climb out of the crash and reboot the AI core',
        enemies: [{ type: 'blork', count: 3 }], pickups: [{ type: 'ammo' }], cover: 0.5, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: 'Rebooting. Diagnostics complete: you are alive, which is statistically rude of you.' },
          { speaker: 'Vanguard', line: "Good to have you too, IRIS. What's hostile?" },
          { speaker: 'IRIS', line: 'Three small jelly persons. One is saluting you. I advise shooting it anyway.' },
        ] },
      { kind: 'outdoor', size: 'l', objectiveText: 'Push through the debris field',
        enemies: [{ type: 'blork', count: 5 }], pickups: [{ type: 'weapon', weapon: 'rifle' }], cover: 0.4, event: 'ambush',
        dialogue: [
          { speaker: 'Blorkling', line: 'Squeak! Squeak?! ...Brenda, are we ALLOWED to attack the big angry one?' },
          { speaker: 'Vanguard', line: "Found a rifle in the wreckage. Now we're talking." },
        ] },
      { kind: 'corridor', size: 'm', objectiveText: 'Restore power to the comms relay',
        enemies: [{ type: 'blork', count: 4 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'health' }], cover: 0.6, event: 'reactor',
        dialogue: [
          { speaker: 'IRIS', line: 'The large magenta one is building up to a charge. It cannot turn. Simply... step aside.' },
          { speaker: 'Vanguard', line: "Noted. Console's hot — patching the relay now." },
        ] },
      { kind: 'hall', size: 'l', objectiveText: 'Reach the high ground overlook',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'health' }, { type: 'ammo' }], cover: 0.5, event: 'none',
        dialogue: [
          { speaker: 'Vanguard', line: 'There. Top of the ridge. We get eyes on this whole... ring.' },
          { speaker: 'IRIS', line: 'The horizon curves upward, Sergeant. Into the sky. I recommend you do not think about it.' },
        ] },
    ],
  },
  {
    id: 'm02', name: 'The Welcome Committee',
    brief: 'A survivor beacon leads Vanguard into a Coalition forward camp strung with motivational posters and jiggling salutes. The wobbly things are organized, numerous, and they think you are trespassing on their worksite.',
    outro: 'Camp cleared. The joke army has muscle now, and IRIS just translated something nobody wanted to hear: they think the ring is their friend.',
    skybox: 'ring', music: 'tension',
    palette: { floor: '#6b5d44', wall: '#3f4a3a', accent: '#7fb84d', fog: '#9aa66e' },
    startWeapons: ['pistol', 'rifle'], finale: false,
    segments: [
      { kind: 'outdoor', size: 'm', objectiveText: 'Breach the Coalition camp perimeter',
        enemies: [{ type: 'blork', count: 5 }], pickups: [{ type: 'ammo' }], cover: 0.35, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: "Beacon's dead ahead. Also dead ahead: roughly forty googly eyes that just noticed you." },
          { speaker: 'Vanguard', line: 'Forty eyes, twenty enemies. I can do that math.' },
        ] },
      { kind: 'corridor', size: 'm', objectiveText: 'Push through the scaffolding into the camp',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'health' }], cover: 0.5, event: 'ambush',
        dialogue: [
          { speaker: 'IRIS', line: "New contact. Bigger. Wobblier. It's reading a motivational poster for courage." },
          { speaker: 'Vanguard', line: 'Of course the punchline army brought a heavyweight.' },
        ] },
      { kind: 'arena', size: 'l', objectiveText: 'Hold the camp square against the bruiser shift',
        enemies: [{ type: 'blork', count: 5 }, { type: 'gurg', count: 2 }], pickups: [{ type: 'ammo' }, { type: 'health' }], cover: 0.45, event: 'ambush',
        dialogue: [
          { speaker: 'Gurglethud', line: 'RRRAAAUGH— *clears throat* —raugh. Did anyone see me trip? Nobody saw that.' },
          { speaker: 'Vanguard', line: "I saw it. I'll narrate it at your funeral." },
        ] },
      { kind: 'hall', size: 'm', objectiveText: 'Tap the Coalition comms relay so IRIS can decode the squeaks',
        enemies: [{ type: 'blork', count: 4 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'health' }], cover: 0.4, event: 'reactor',
        dialogue: [
          { speaker: 'IRIS', line: "Decoding their chatter... Vanguard, they're not defending the ring. They love it. They think the Aureole is a friend." },
          { speaker: 'Vanguard', line: "Great. We're the home invasion in their feel-good story." },
          { speaker: 'IRIS', line: "Worse. They're keeping it running. And they have no idea what 'it' is." },
        ] },
    ],
  },
  {
    id: 'm03', name: 'The Hum Beneath',
    brief: 'The beacon drags you into the Aureole maintenance underbelly. Reroute power at the control spire to crack the blast doors — and meet the googly-eyed clerks who keep this place running without a clue what it is.',
    outro: 'The blast doors grind open and a deep hum rolls through the tunnels. Whatever you just woke up, it heard you.',
    skybox: 'interior', music: 'tension',
    palette: { floor: '#1c2630', wall: '#283641', accent: '#3fb6a8', fog: '#0e161d' },
    startWeapons: ['pistol', 'rifle'], finale: false,
    segments: [
      { kind: 'corridor', size: 'm', objectiveText: 'Descend into the maintenance tunnels',
        enemies: [{ type: 'blork', count: 5 }], pickups: [{ type: 'ammo' }], cover: 0.3, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: 'Beacon signal terminates somewhere below us. Also, the walls are older than your entire species. Try not to lean on anything.' },
          { speaker: 'Vanguard', line: 'Here lies Vance Orion, killed by a hallway.' },
        ] },
      { kind: 'hall', size: 'l', objectiveText: 'Push through the coolant gallery',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 2 }], pickups: [{ type: 'health' }, { type: 'ammo' }], cover: 0.5, event: 'ambush',
        dialogue: [
          { speaker: 'IRIS', line: 'Two heavy signatures incoming. They are large, slow, and apparently allergic to walls.' },
          { speaker: 'IRIS', line: 'He charged into the pillar. He is checking if anyone saw. Adorable. Still kill it.' },
        ] },
      { kind: 'arena', size: 'l', objectiveText: "Defend the control spire — clear the officer's squad",
        enemies: [{ type: 'blork', count: 4 }, { type: 'floater', count: 2 }, { type: 'wobbler', count: 1 }], pickups: [{ type: 'weapon', weapon: 'goocaster' }, { type: 'health' }], cover: 0.6, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: 'New contact — taller, crowned, carrying a clipboard. It is projecting a shield over its squad. Pop the bubble before it files anything.' },
          { speaker: 'Quivermaster Sprocket', line: 'MAINTAIN FORMATION! Per memo three! ...does anyone have a copy of memo three?' },
          { speaker: 'Vanguard', line: "Found a goo-cannon. It's complaining at me, but it eats shields. We'll get along." },
        ] },
      { kind: 'corridor', size: 'm', objectiveText: 'Reroute power and open the blast doors',
        enemies: [{ type: 'blork', count: 4 }, { type: 'wobbler', count: 1 }], pickups: [{ type: 'ammo' }], cover: 0.4, event: 'reactor',
        dialogue: [
          { speaker: 'Vanguard', line: "Console's lit up. Rerouting power to the blast doors. Easy." },
          { speaker: 'IRIS', line: 'Power rerouted. The doors are opening. Also the entire region just... woke up. That hum is the whole structure, Sergeant.' },
          { speaker: 'Vanguard', line: "Tell me that's a good hum, IRIS." },
        ] },
    ],
  },
  {
    id: 'm04', name: 'Eyes in the Vault',
    brief: 'Sgt. Orion breaches the Aureole data vault hunting for the lost fleet. IRIS starts decrypting the archive while Coalition drones flood the bottomless shaft. The truth about this ring is one slate away.',
    outro: "The fleet isn't lost. It was bait. And we just walked into the trap's filing cabinet.",
    skybox: 'interior', music: 'tension',
    palette: { floor: '#1b2230', wall: '#2a3650', accent: '#46e0ff', fog: '#0c1426' },
    startWeapons: ['rifle', 'pistol'], finale: false,
    segments: [
      { kind: 'corridor', size: 'm', objectiveText: 'Breach the archive antechamber',
        enemies: [{ type: 'blork', count: 5 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'ammo' }], cover: 0.4, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: 'Vault door is a meter thick and ten thousand years old. The lock, however, is held shut with what I can only describe as tape.' },
          { speaker: 'Vanguard', line: 'Ancient superstructure, jelly-empire maintenance budget. Cracking it.' },
        ] },
      { kind: 'hall', size: 'l', objectiveText: 'Clear the lower stacks',
        enemies: [{ type: 'blork', count: 6 }, { type: 'floater', count: 2 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'weapon', weapon: 'stinger' }, { type: 'health' }], cover: 0.35, event: 'ambush',
        dialogue: [
          { speaker: 'Bobbins', line: '*hic* — incoming! *hic* hold on — *hic* — okay NOW. No wait. *hic*' },
          { speaker: 'IRIS', line: "Those floating ones snipe from the rafters. There's a missile pod on the rack to your left. Paint them. Be unsporting about it." },
        ] },
      { kind: 'arena', size: 'l', objectiveText: 'Defend the shaft as drones converge',
        enemies: [{ type: 'floater', count: 4 }, { type: 'blork', count: 4 }, { type: 'gurg', count: 2 }, { type: 'popper', count: 2 }], pickups: [{ type: 'ammo' }, { type: 'health' }], cover: 0.5, event: 'ambush',
        dialogue: [
          { speaker: 'Vanguard', line: 'They keep coming up from the shaft. How deep does this thing go?' },
          { speaker: 'IRIS', line: 'And now the round red ones — they sprint in and detonate. Shoot them early, Sergeant; hugging one is a closed-casket decision.' },
          { speaker: 'IRIS', line: "Reading says 'undefined.' The architects left that field blank, which is the single most reassuring thing I've ever decrypted." },
        ] },
      { kind: 'bridge', size: 'm', objectiveText: 'Reach the master slate and let IRIS decrypt the records',
        enemies: [{ type: 'floater', count: 3 }, { type: 'blork', count: 3 }], pickups: [{ type: 'ammo' }], cover: 0.25, event: 'reactor',
        dialogue: [
          { speaker: 'IRIS', line: "Decrypting... Vanguard. This isn't a refuge. The Aureole is catalogued. As a 'containment array.' We're standing inside the lid of something." },
          { speaker: 'Vanguard', line: 'And the lost fleet?' },
          { speaker: 'IRIS', line: 'There is no record of a distress call going out. Only one coming in. The ring sent it. We answered.' },
        ] },
    ],
  },
  {
    id: 'm05', name: 'The Beacon Lied',
    brief: 'Trace the distress signal to its source inside the spine cathedral. The beacon was never a cry for help — and every system you powered to survive has been arming the ring. Shut it down.',
    outro: "The beacon dies. The Aureole keeps humming. We weren't escaping the trap, Vanguard. We were finishing it.",
    skybox: 'ring', music: 'tension',
    palette: { floor: '#2a2533', wall: '#3d3550', accent: '#c9a227', fog: '#1a1622' },
    startWeapons: ['rifle', 'pistol'], finale: false,
    segments: [
      { kind: 'hall', size: 'l', objectiveText: 'Reach the transmitter cathedral',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 2 }, { type: 'bulwark', count: 1 }], pickups: [{ type: 'ammo' }], cover: 0.4, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: 'Distress signal is dead ahead. Source confirmed. Survivors: zero. Antennae the size of mountains: several.' },
          { speaker: 'IRIS', line: 'Also a slab of jelly hauling a riot shield. You will not chew through the front — get around it and shoot the part with the regrets.' },
          { speaker: 'Vanguard', line: "Zero survivors but a signal's still pinging. Who's broadcasting?" },
        ] },
      { kind: 'corridor', size: 'm', objectiveText: 'Push through the antenna conduits',
        enemies: [{ type: 'blork', count: 5 }, { type: 'floater', count: 3 }], pickups: [{ type: 'weapon', weapon: 'stinger' }], cover: 0.5, event: 'ambush',
        dialogue: [
          { speaker: 'Bobbins', line: '(hic) FORMATION! Wait, which one is the enemy? The loud one. Probably the loud one.' },
          { speaker: 'IRIS', line: 'Stinger pod, port side. Try not to hug it — the missiles whine like they pay rent.' },
        ] },
      { kind: 'arena', size: 'l', objectiveText: 'Hold the transmitter floor',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 2 }, { type: 'floater', count: 2 }, { type: 'wobbler', count: 1 }], pickups: [{ type: 'health' }, { type: 'ammo' }], cover: 0.6, event: 'ambush',
        dialogue: [
          { speaker: 'Quivermaster Sprocket', line: 'MAINTAIN the formation! Per page four of the handbook! There IS no page four, I am bluffing!' },
          { speaker: 'IRIS', line: 'Flank him or burst it. He is holding a clipboard, Vanguard. He brought paperwork to a war.' },
        ] },
      { kind: 'hall', size: 'l', objectiveText: 'Override the beacon console',
        enemies: [{ type: 'blork', count: 4 }, { type: 'floater', count: 3 }, { type: 'wobbler', count: 1 }], pickups: [{ type: 'health' }, { type: 'ammo' }], cover: 0.5, event: 'reactor',
        dialogue: [
          { speaker: 'IRIS', line: "Console's live. Vanguard, the beacon isn't a relay. It's bait. The ring sent it. It called the fleet here." },
          { speaker: 'Vanguard', line: '...Every reactor I lit to stay alive.' },
          { speaker: 'IRIS', line: "Armed it. One nudge at a time. We weren't escaping the trap. We were the last bolt in it. I'm so sorry. Please pull the plug." },
        ] },
    ],
  },
  {
    id: 'm06', name: 'Cutting the Cord',
    brief: 'The Aureole is charging toward firing capacity. Sever the primary power conduits spanning the chasm before the ring goes hot. The Coalition has thrown everything it has at the bridges.',
    outro: 'Conduit severed. The ring shudders, the charge stalls — and the whole structure starts coming apart at the seams. That was supposed to be the good news.',
    skybox: 'ring', music: 'combat',
    palette: { floor: '#1b2a3a', wall: '#2c4258', accent: '#39e0ff', fog: '#0a141f' },
    startWeapons: ['rifle', 'stinger'], finale: false,
    segments: [
      { kind: 'bridge', size: 'm', objectiveText: 'Reach the first conduit junction',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 2 }], pickups: [{ type: 'ammo' }], cover: 0.3, event: 'none',
        dialogue: [
          { speaker: 'IRIS', line: 'Charge level is at sixty-one percent and climbing. The bridge ahead is, technically speaking, made of weaponized electricity.' },
          { speaker: 'Vanguard', line: "And it's the only way across?" },
        ] },
      { kind: 'hall', size: 'l', objectiveText: 'Hold the junction and break the Coalition line',
        enemies: [{ type: 'blork', count: 5 }, { type: 'gurg', count: 2 }, { type: 'floater', count: 3 }, { type: 'blinker', count: 2 }], pickups: [{ type: 'weapon', weapon: 'goocaster' }, { type: 'health' }], cover: 0.5, event: 'ambush',
        dialogue: [
          { speaker: 'Blorkling', line: 'Squeak! Squeak-squeak? (Are we... are we allowed to shoot the big scary one?)' },
          { speaker: 'IRIS', line: 'Mind the violet ones — they blink sideways the instant you line up a shot. Lead them, or fire the heartbeat after they reappear.' },
          { speaker: 'Vanguard', line: 'They left a goo-cannon just lying here. The Coalition runs this place like a yard sale.' },
        ] },
      { kind: 'corridor', size: 'm', objectiveText: 'Push through the maintenance span to the officer post',
        enemies: [{ type: 'blork', count: 4 }, { type: 'floater', count: 3 }, { type: 'wobbler', count: 1 }], pickups: [{ type: 'ammo' }], cover: 0.4, event: 'door-lock',
        dialogue: [
          { speaker: 'Quivermaster Sprocket', line: 'MAINTAIN FORMATION! That means everyone faces the same direction! Bobbins, that is a wall.' },
          { speaker: 'IRIS', line: 'Their officer is shielding the squad. Pop the bubble before you bother with the rest of them.' },
        ] },
      { kind: 'bridge', size: 'l', objectiveText: 'Cross the rupturing span to the master conduit',
        enemies: [{ type: 'blork', count: 4 }, { type: 'gurg', count: 3 }, { type: 'floater', count: 2 }, { type: 'wobbler', count: 1 }, { type: 'popper', count: 1 }], pickups: [{ type: 'health' }, { type: 'ammo' }], cover: 0.25, event: 'ambush',
        dialogue: [
          { speaker: 'IRIS', line: "The conduits are venting. Sections of this bridge are now what I would call 'opinion-based flooring.'" },
          { speaker: 'Vanguard', line: "Noted. I'll keep my opinions to the parts that aren't on fire." },
        ] },
      { kind: 'arena', size: 'l', objectiveText: 'Override the master conduit and sever the power line',
        enemies: [{ type: 'blork', count: 5 }, { type: 'gurg', count: 2 }, { type: 'floater', count: 3 }, { type: 'wobbler', count: 2 }], pickups: [{ type: 'weapon', weapon: 'boomstick' }, { type: 'health' }], cover: 0.45, event: 'reactor',
        dialogue: [
          { speaker: 'Vanguard', line: "Override's locked in. Cutting the cord in three... two..." },
          { speaker: 'IRIS', line: "Charge halted. Also the ring just dropped four degrees off true. Congratulations, Sergeant, you've made things worse on a schedule." },
        ] },
    ],
  },
  {
    id: 'm07', name: 'Tantrum',
    brief: 'The Aureole is coming apart. Push through the Coalition last fortified line at the throne-concourse, where the floor is already arguing with gravity, and reach the core before the Supreme Jiggler does something monumentally stupid to "fix" it.',
    outro: 'The Jiggler has welded itself into the controls. Whatever it just did, it made everything worse. One door left.',
    skybox: 'space', music: 'combat',
    palette: { floor: '#2a1d3a', wall: '#3b2a52', accent: '#c83fd6', fog: '#160e22' },
    startWeapons: ['rifle', 'stinger'], finale: false,
    segments: [
      { kind: 'hall', size: 'l', objectiveText: 'Breach the throne-concourse',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 2 }, { type: 'wobbler', count: 1 }, { type: 'bulwark', count: 1 }], pickups: [{ type: 'ammo' }], cover: 0.5, event: 'ambush',
        dialogue: [
          { speaker: 'IRIS', line: "Reading two hundred hostiles ahead and structural integrity at a generous forty percent. I've prepared a eulogy. It's mostly statistics." },
          { speaker: 'Vanguard', line: 'Save it. I do my own eulogy.' },
        ] },
      { kind: 'bridge', size: 'm', objectiveText: 'Cross the splitting concourse before the floor leaves',
        enemies: [{ type: 'blork', count: 4 }, { type: 'floater', count: 3 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'weapon', weapon: 'boomstick' }], cover: 0.25, event: 'door-lock',
        dialogue: [
          { speaker: 'Vanguard', line: "Wall just peeled off. That's open space out there." },
          { speaker: 'IRIS', line: 'Correct. Please do not stand on the parts of the floor that are also leaving.' },
        ] },
      { kind: 'arena', size: 'l', objectiveText: 'Hold the line and overload the throne-junction console',
        enemies: [{ type: 'blork', count: 5 }, { type: 'gurg', count: 2 }, { type: 'wobbler', count: 2 }, { type: 'floater', count: 2 }, { type: 'medic', count: 1 }], pickups: [{ type: 'health' }, { type: 'ammo' }], cover: 0.4, event: 'reactor',
        dialogue: [
          { speaker: 'Quivermaster Sprocket', line: 'MAINTAIN FORMATION! Per subsection nine, panicking is a fireable offense!' },
          { speaker: 'IRIS', line: "There's a little green drone topping the big ones back up. Kill the nurse first, Sergeant." },
          { speaker: 'IRIS', line: "Console's hot. The readout's screaming. I find that motivational." },
        ] },
      { kind: 'corridor', size: 'm', objectiveText: 'Reach the core access door',
        enemies: [{ type: 'blork', count: 4 }, { type: 'wobbler', count: 1 }, { type: 'floater', count: 2 }], pickups: [{ type: 'ammo' }], cover: 0.3, event: 'none',
        dialogue: [
          { speaker: 'Vanguard', line: "That's the Jiggler. It's... bolting itself into the controls." },
          { speaker: 'IRIS', line: 'It thinks it is stabilizing the ring. It is doing the precise opposite, with confidence.' },
        ] },
    ],
  },
  {
    id: 'm08', name: 'Halo, Goodbye',
    brief: 'The Aureole is overloading and shaking itself to scrap. Commandeer a Coalition transport, run the gauntlet across the breaking ring, then end Supreme Jiggler Pomplemoose where it sits — fused to the dying core.',
    outro: 'The halo goes dark behind you. For once, the universe lets your last stand actually be your last stand. Drive, Vanguard.',
    skybox: 'ring', music: 'finale',
    palette: { floor: '#2a1f3d', wall: '#43306b', accent: '#ff5a8c', fog: '#1a1230' },
    startWeapons: ['rifle', 'boomstick'], finale: true,
    segments: [
      { kind: 'corridor', size: 'm', objectiveText: 'Reach the transport bay before the deck gives out',
        enemies: [{ type: 'blork', count: 6 }, { type: 'gurg', count: 2 }, { type: 'popper', count: 2 }], pickups: [{ type: 'ammo' }], cover: 0.4, event: 'ambush',
        dialogue: [
          { speaker: 'IRIS', line: "Structural integrity is at twelve percent and dropping. I'd round up, but I respect you too much to lie." },
          { speaker: 'Vanguard', line: 'Twelve percent of a ring the size of a continent is still a lot of ring.' },
        ] },
      { kind: 'bridge', size: 'l', objectiveText: 'Put down Quivermaster Sprocket, then reroute the core controls',
        enemies: [{ type: 'sprocket', count: 1 }, { type: 'floater', count: 3 }, { type: 'gurg', count: 1 }], pickups: [{ type: 'weapon', weapon: 'stinger' }, { type: 'health' }], cover: 0.25, event: 'reactor',
        dialogue: [
          { speaker: 'Quivermaster Sprocket', line: 'HALT! None cross the Quivermaster’s span un-quivered. Behold my magnificent— *gears grind* —apparatus!' },
          { speaker: 'IRIS', line: 'Mini-boss. Shielded, over-accessorised. Pop the bubble, then the ego — then slot the override.' },
          { speaker: 'Vanguard', line: 'One unscrewed Quivermaster, coming right up.' },
        ] },
      { kind: 'arena', size: 'l', objectiveText: 'Destroy the control nodes on Supreme Jiggler Pomplemoose',
        enemies: [{ type: 'boss', count: 1 }, { type: 'blork', count: 8 }, { type: 'floater', count: 3 }], pickups: [{ type: 'health' }, { type: 'ammo' }, { type: 'weapon', weapon: 'goocaster' }], cover: 0.3, event: 'boss',
        dialogue: [
          { speaker: 'Pomplemoose', line: 'BEHOLD, marine! The Aureole is PERFECTLY under contr— *floor shakes* —under control. It is fine. WE ARE ALL FINE.' },
          { speaker: 'Vanguard', line: "You're a billion googly eyes wired into a bomb. Hold still." },
          { speaker: 'IRIS', line: 'Target the throbbing nodes. They glow when he monologues — so, constantly.' },
        ] },
      { kind: 'outdoor', size: 'l', objectiveText: 'Reach the lost Vanguard before the ring goes — drive into the hangar.',
        enemies: [{ type: 'blork', count: 10 }, { type: 'floater', count: 8 }, { type: 'wobbler', count: 2 }], pickups: [], cover: 0, event: 'vehicle-escape',
        dialogue: [
          { speaker: 'IRIS', line: "Transport's ours, the road is NOT. The ring is shedding its plates into the dark — stay on what's left of it." },
          { speaker: 'Vanguard', line: 'No rails, no margin. Cozy. Where am I going?' },
          { speaker: 'IRIS', line: 'The lost Vanguard — dead ahead through the collapse. Put your cursor on the Wobble and I will personally scrub them off our backs.' },
          { speaker: 'Vanguard', line: 'Then keep that gun warm, IRIS. Halo... goodbye.' },
        ] },
    ],
  },
];

export const CAMPAIGN = RAW_CAMPAIGN.map(normalizeMission);

// ---- progress persistence ----
const PROGRESS_KEY = 'webalo.progress.v1';

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { unlocked: 0, completed: [] };
}

export function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

export function markCompleted(index) {
  const p = loadProgress();
  if (!p.completed.includes(index)) p.completed.push(index);
  p.unlocked = Math.max(p.unlocked, Math.min(index + 1, CAMPAIGN.length - 1));
  saveProgress(p);
  return p;
}

// ---- mid-mission checkpoints ----
// Stored per mission index: { segment, player } where player is a Player
// snapshot (vitals + loadout). Lets death/tab-close resume from the last
// cleared room instead of the mission start.
const CHECKPOINT_KEY = 'webalo.checkpoint.v1';

function _allCheckpoints() {
  try { const raw = localStorage.getItem(CHECKPOINT_KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
export function loadCheckpoint(missionIndex) {
  const all = _allCheckpoints();
  return all[missionIndex] || null;
}
export function saveCheckpoint(missionIndex, data) {
  const all = _allCheckpoints();
  all[missionIndex] = data;
  try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
}
export function clearCheckpoint(missionIndex) {
  const all = _allCheckpoints();
  if (all[missionIndex] === undefined) return;
  delete all[missionIndex];
  try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
}

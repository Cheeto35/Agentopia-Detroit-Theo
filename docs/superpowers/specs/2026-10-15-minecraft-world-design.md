# Agentopia in Minecraft — design

Date: 2026-10-15
Status: approved in conversation, awaiting written-spec review

## Goal

Replace the web dashboard as the main way to watch Agentopia with a Minecraft
world. Every simulated agent is an NPC that lives in a generated town, walks to
the places its plans name, talks to other agents with visible chat, and builds
real structures. The owner can play as a normal character or switch to a free
spectator camera.

### Constraints (from the owner)

- **Low resource use.** The owner runs a local LLM (LM Studio) alongside the
  simulation (Ollama, 102 agents) on one PC (i7-10700, 48 GB RAM, RTX 2060
  Super 8 GB). The Minecraft side must add no LLM calls and stay light on CPU,
  RAM and GPU.
- The existing simulation, its weekly rhythm and its AI calls stay as they are.
- The owner's existing Forge 1.20.1 server (port 25565) and its world are not
  touched.

### Decisions made

| Question | Decision |
|---|---|
| Role of Minecraft | NPCs act in the world (not a passive view) |
| Server | New, separate Forge 1.20.1 server just for the agents |
| Time model | Keep the sim's weekly rhythm; Minecraft acts it out |
| Map | Town auto-generated from the run's place list on a superflat world |
| In-world actions, v1 | Walk + talk (always) and **build**. No gathering, farming, item trading or player conversation in v1 |
| Architecture | Python sim stays the brain; a Forge mod executes and reports back |
| Client | The same mod jar is installed on the new server and the owner's Forge client |

### Out of scope for v1

Gathering/mining/farming, item trading between agents, NPCs talking to the
player, demolishing or editing builds, the Detroit world, replacing the web
dashboard (it stays as a fallback).

## Architecture

```
 Python sim (unchanged loop)                Forge 1.20.1 mod "agentopia-mc"
 ┌──────────────────────────┐   JSON lines  ┌───────────────────────────────┐
 │ world.py phases          │  over TCP     │ BridgeServer 127.0.0.1:8770   │
 │  └─ minecraft hooks ─────┼──────────────▶│  ├─ AgentRegistry (NPCs)      │
 │ src/minecraft/bridge.py  │◀──────────────┼──├─ TownGenerator / TownMap    │
 │  (client, optional)      │   events      │  ├─ BuildExecutor             │
 └──────────────────────────┘               │  └─ PhaseClock (sky, HUD)     │
                                            │ Client: NPC renderer, camera  │
                                            └───────────────────────────────┘
```

### Units

**Python (`src/minecraft/`)**

- `bridge.py`: `MinecraftBridge` client. Connects to the mod, sends commands,
  waits for replies with per-command timeouts, and reconnects lazily. Every
  public method returns a result or raises `BridgeUnavailable`; callers never
  block indefinitely.
- `hooks.py`: the only place the sim talks to Minecraft. Functions called from
  `world.py`/`activity.py` at phase boundaries: `on_phase`, `on_contact_message`,
  `on_activity_start` and `request_build`. Each one is a no-op when Minecraft
  is disabled or unreachable.
- `blueprints.py`: the list of buildable blueprints (id, name, one-line
  description, money cost). Shared with the prompt text and checked against the
  mod's list during the handshake.

**Java mod (`minecraft/agentopia-mc/`, ForgeGradle project)**

- `bridge/BridgeServer`: localhost-only TCP listener (one client at a time).
  It parses JSON lines and dispatches each command onto the server thread.
- `npc/AgentEntity`: `PathfinderMob` with the player model, a name tag, and
  invulnerability. It is persistent and never despawns.
- `npc/AgentRegistry`: maps agent names to entities. It handles sync, spawning
  and removal, plus walking with a teleport fallback.
- `town/TownGenerator`: builds the town from the place list.
- `town/TownMap`: place name to bounding box, door and plot list; stored as
  `agentopia_town.json` in the world folder.
- `build/Blueprint` and `build/BuildExecutor`: block lists, plot allocation and
  timed placement.
- `time/PhaseClock`: sets world time from the sim phase. Also sends the
  action-bar HUD text to spectating operators.
- Client-only: `client/AgentRenderer` (player model and default skins) and
  `client/CameraKey` (the toggle hotkey).
- `command/AgentopiaCommand`: `/agentopia town generate`,
  `/agentopia follow <name>`, `/agentopia status`.

## Bridge protocol

Newline-delimited JSON over TCP on `127.0.0.1:8770`. Requests carry an `id`.
Replies echo it, and events carry `event`.

Handshake: `{"id":1,"cmd":"hello","version":1}` →
`{"id":1,"ok":true,"version":1,"blueprints":["garden",...]}`. On a version
mismatch, Minecraft is disabled for the session and a warning is logged.

| Command | Fields | Reply / events |
|---|---|---|
| `sync_agents` | `agents:[{name, faction}]`, `places:[{name, size}]` | `ok {town_ready}`; once the town exists, the mod spawns missing NPCs in their rooms and removes extras |
| `set_phase` | `year, week, stage, day, slot, send_home` | `ok`; sky time and HUD update. If `send_home` is true (plan, review, settle), every NPC walks to its room |
| `move` | `agent` and either `place` (a place name or `"home"`) or `target_agent` | `ok` immediately (the sim does not wait for arrival); event `arrived {agent, teleported}` |
| `say` | `agent, to, text` | `ok`; chat bubble above the NPC and a line in server chat |
| `build` | `agent, blueprint, near` (`"home"` or place name) | `ok {job, plot}` or `error {reason}`; events `build_progress {job, pct}`, then `build_done {job, plot, place}` or `build_failed {job, reason}` |

Error reasons: `unknown_agent`, `unknown_place`, `no_free_plot`,
`unknown_blueprint`, `busy`, `town_not_ready`, `bad_request`.

## Behaviour

### Week mapping

| Sim stage | Minecraft |
|---|---|
| begin / plan | Night; NPCs are moved to their apartment rooms |
| before_contact | Dawn; NPCs stay home |
| contact slot *n* | Morning; each NPC moves to the agent it contacts (or to a shared place), and the conversation's messages are sent with `say` |
| after_contact | Midday |
| activity day *d* | Day; each NPC moves to its activity's place. A build activity calls `build` |
| review / settle | Evening, then night; NPCs return home |

`doDaylightCycle` is off. `PhaseClock` sets the time, so the sky follows the
sim, whatever its speed (about 10 real minutes per sim day at 102 agents).

### NPCs

- Look: one of Minecraft's built-in default player skins, chosen by a hash of
  the agent's name, so it is stable across restarts. Faction members get a
  coloured name tag. Nothing is fetched from the internet.
- Movement: ground navigation at walking speed, in segments of at most 48
  blocks to keep pathfinding cheap. If an NPC makes no progress for 20 s it
  teleports to the target, and `arrived` reports `teleported:true`.
- **Where NPCs go:**
  - Joint and public activities: the activity's location, matched to a known
    place name.
  - Solo activities: the first known place named in the activity text,
    otherwise home.
  - Builds: the plot.
- **Chat bubbles:** a temporary text display above the NPC for 8 s.
- The mod's outgoing messages to the sim go through a bounded queue on a
  writer thread, so a paused or stalled sim can never block the Minecraft
  server thread.
- Idle: short random wander within the current place's bounding box.
- The sim decides who exists and where they should be. The mod owns
  coordinates. On every (re)connect, `sync_agents` plus a `move` per NPC
  restores consistency.

### Town

- World type: superflat. Generated once by `/agentopia town generate` after the
  first `sync_agents` (the mod needs the place list).
- Layout: a grid of 16×16 cells, one chunk each, with paths between buildings.
  - **Apartment blocks:** single-story, 6 rooms of 5×5 (3×3 inside) per cell,
    one room per agent. That is 17 cells for 102 agents. Everything is at
    ground level so NPCs never path up stairs.
  - **Public places:** one building per place, sized by `size` (small 7×7,
    medium 9×9, large 13×13), with a name sign.
  - **The two faction HQs** (13×13).
  - **Build plots:** at least 60 empty 7×7 plots, 4 per cell, interleaved
    between the public places.
- The town's chunks are force-loaded so NPCs act with no player nearby; the
  target area is at most 12×12 chunks.

### Building

Blueprints for v1 (costs are sim money):

| id | Name | Approx. blocks | Cost |
|---|---|---|---|
| `garden` | Garden patch | 40 | 60 |
| `bench_lamp` | Bench and lamp post | 12 | 40 |
| `market_stall` | Market stall | 70 | 150 |
| `shed` | Small shed | 110 | 200 |
| `mural` | Mural wall | 45 | 80 |
| `room_upgrade` | Upgrade my room | 6 | 120 (furniture inside the agent's own 3×3 room, no plot) |

- **Sim side:** during a solo activity's act turn, the agent's function list
  gains `build(blueprint, near)`. The prompt gains a short blueprint list with
  costs. If the agent cannot afford a blueprint, the sim rejects the call before
  it reaches Minecraft and tells the agent.
- **Mod side:** reserve the free plot nearest to `near`. The NPC walks there
  and places blocks in blueprint order, about 2 blocks per second with an arm
  swing, then sends `build_done`.
- **Result:** the sim waits for `build_done` or `build_failed` for up to
  240 s. Success becomes outcome text, for example "You built a garden next to
  the Corner Coffee Shop". It is passed to the existing GodModel evaluation, and
  the money cost goes through the existing `delta_money`. The finished build is
  appended to that place's `objects` in the run's `locations.json`
  ("garden built by Amara Okafor"), so other agents see it in place
  descriptions they already receive. On timeout or failure the outcome says
  what went wrong. A build that is still running when the wait times out keeps
  going in Minecraft and is recorded when it finishes.
- Builds persist in the world and in `agentopia_town.json` with their owner.

### Camera

- Hotkey **V** (rebindable) for operators. Each press toggles between the
  player and spectator mode. Leaving spectator restores the saved position,
  game mode and inventory.
- `/agentopia follow <name>` attaches the spectator camera to that agent.
- While spectating, the action bar shows the sim clock (for example
  "Week 2 · Talk round 3").

## Configuration

`config.json` gains an optional section. If it is absent, the sim runs
without Minecraft exactly as today:

```json
"minecraft": { "enabled": true, "host": "127.0.0.1", "port": 8770,
               "reply_timeout_s": 5, "build_timeout_s": 240 }
```

## Failure handling

- **Minecraft not running, or the handshake fails:** a warning is logged once
  per phase, and every hook becomes a no-op. The sim result is identical to a
  run without Minecraft.
- **Connection dropped mid-phase:** pending calls raise `BridgeUnavailable`.
  A build turns into "the build site was unreachable" in the outcome, and the
  bridge reconnects at the next phase boundary.
- **Mod restart:** the next connect performs a full `sync_agents`.
- **`PAUSE-SIM.bat`:** the sim freezes, NPCs idle, and pending bridge calls
  resume with the sim.
- **Malformed message:** the receiver logs it, skips it and does not crash.

## Resources

- **New server:** `-Xmx2G`, view distance 6, simulation distance 4, superflat,
  and started at below-normal priority by `START-MC-SERVER.bat`.
- **Agent load:** NPCs only tick inside the force-loaded town; 102 pathfinding
  mobs in that area is a light load for a Minecraft server.
- **AI:** no new LLM calls. `build` is one more function in an existing call.
- **Development builds:** the first ForgeGradle setup is heavy (about 1 GB
  download and a Minecraft decompile). Run it with below-normal priority,
  `org.gradle.workers.max=2` and the daemon stopped afterwards, and confirm
  with the owner before the first setup.

## Testing

- **Python (pytest):**
  - The bridge client against an in-process fake mod server: handshake, each
    command, timeouts, disconnect then reconnect, and malformed lines.
  - Hooks with a fake bridge, checking that disabled or unavailable means no
    side effects.
  - The `build` function path: affordability check, success text, and the
    failure and timeout outcomes.
- **Java (JUnit, no game):**
  - Plot allocation: nearest free plot, and none left.
  - Blueprint block ordering and bounds.
  - Town layout: no overlapping footprints for 102 agents and 31 places.
  - Protocol parsing.
- **In-game smoke test** on the new server, at low priority:
  1. Generate the town.
  2. Sync 3 agents.
  3. Drive `move`, `say` and `build` from a Python script, and confirm the
     events and the visible result.
  4. Toggle the camera.
- **End-to-end:** a short sim run with about 10 agents and Minecraft enabled,
  when the owner allows the GPU time.

## Deliverables

- The `minecraft/agentopia-mc/` Forge project and the built jar.
- `minecraft/server/` setup, plus `START-MC-SERVER.bat`: a new Forge 1.20.1
  server with a superflat world, port 25566, `-Xmx2G` and below-normal priority.
- `src/minecraft/` (bridge, hooks, blueprints), plus small hook calls in
  `world.py` and `activity.py`, plus the `minecraft` config section.
- Setup notes in `WINDOWS-SETUP.md`: install the jar in the client's `mods`
  folder, start the server, run `/agentopia town generate`, enable it in
  `config.json`.

# Agentopia in Minecraft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every simulated agent becomes an NPC in a generated Minecraft town that walks to where its plans say, shows its conversations as chat, and builds real structures, while the owner can switch between playing and a free spectator camera.

**Architecture:** The Python simulation stays the brain and gains a small optional `src/minecraft/` package (bridge client, hooks, blueprint catalog) called at existing phase boundaries. A Forge 1.20.1 mod (`agentopia-mc`) listens on `127.0.0.1:8770`, executes commands (move, say, build, set_phase) with plain Java code and reports events back. When Minecraft is off, every hook is a no-op.

**Tech Stack:** Python 3.13 (stdlib only: `socket`, `threading`, `json`, `unittest`), Forge 1.20.1-47.4.0 with ForgeGradle 6 and official Mojang mappings, Java 17 target (JDK 21 installed), Gson (bundled with Minecraft), JUnit 5.

**Spec:** `docs/superpowers/specs/2026-10-15-minecraft-world-design.md`

## Global Constraints

- Minecraft 1.20.1, Forge 47.4.0, official (mojmap) mappings, mod id `agentopia`, Java package `com.agentopia.mc`.
- Bridge: newline-delimited JSON over TCP on `127.0.0.1:8770`, localhost only, protocol version `1`.
- Agent server: a new Forge server in `minecraft/server/`, port `25566`, `-Xmx2G`, superflat, below-normal priority. The owner's existing server on 25565 is never touched.
- No new LLM calls anywhere. `build` is one more action inside the existing solo-activity call.
- Python: standard library only, tests use `unittest` (the repo's existing pattern). No new pip dependencies.
- With `config["minecraft"]["enabled"]` false or missing, the sim behaves exactly as today. Every hook is wrapped so an exception inside it can never stop the sim.
- Gradle runs only through `gradlew-low.bat` (below-normal priority, at most 2 workers, no daemon). Get the owner's OK before the first Gradle run, because the first setup downloads about 1 GB and decompiles Minecraft.
- Blueprint ids and costs, identical in Python and Java: `garden` $60, `bench_lamp` $40, `mural` $80, `room_upgrade` $120 (inside own room, no plot), `market_stall` $150, `shed` $200.
- Error reasons: `unknown_agent`, `unknown_place`, `no_free_plot`, `unknown_blueprint`, `busy`, `town_not_ready`, `bad_request`.
- Timeouts: replies 5 s (`reply_timeout_s`), builds 240 s (`build_timeout_s`). NPC stuck fallback: teleport after 400 ticks (20 s) with no progress.
- Commit messages follow the repo style (plain imperative sentence) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The sim paused with `PAUSE-SIM.bat` while the mod keeps sending events.** The Minecraft server thread must never block on the socket. Outgoing lines go through a bounded `LineOutbox` drained by a writer thread, and overflow drops lines. Pinned by `LineOutboxTest` (Task 5).
2. **Agent names with accents, dots and spaces** (`Étienne Bellamy`, `Dr. Amelia Grant`) must survive the bridge in both directions and work in `/agentopia follow`. Pinned by the UTF-8 round-trip test (Task 2), `ProtocolTest.parsesUtf8Names` (Task 5) and the greedy-string argument (Task 11).
3. **Activity locations that match no known place** ("my apartment", "a quiet bench downtown") must leave the NPC where it is, not error. Pinned by `test_activity_start_unmatched_location_does_nothing` (Task 3).
4. **The mod restarts or the connection drops mid-run.** The next phase must reconnect and re-sync, without the sim raising. Pinned by `test_disconnect_then_reconnect` (Task 2) and `test_phase_reconnects_and_resyncs` (Task 3).
5. **No free plot, or an agent already building**, must become a sensible in-character outcome with no money charged. Pinned by `test_plots_exhausted` (Task 6) and `test_build_rejected_maps_reason_and_charges_nothing` (Task 3).

---

## File Structure

**Python (new)**
- `src/minecraft/__init__.py`: package marker.
- `src/minecraft/blueprints.py`: blueprint catalog and the prompt text describing it.
- `src/minecraft/bridge.py`: `MinecraftBridge` TCP client and `BridgeUnavailable`.
- `src/minecraft/hooks.py`: `MinecraftHooks` (all Minecraft behaviour, dependency-injected) plus module-level adapter functions the sim calls.
- `tests/__init__.py`, `tests/minecraft/__init__.py`, `tests/minecraft/fake_mod.py`, `tests/minecraft/test_blueprints.py`, `tests/minecraft/test_bridge.py`, `tests/minecraft/test_hooks.py`, `tests/minecraft/test_locations.py`.
- `scripts/mc_smoke.py`: drives the mod by hand for the in-game smoke test.

**Python (modified)**
- `src/world/world.py`: `attach` after faction bootstrap; `on_phase` after each stage log line.
- `src/world/scheduling.py`: `MessageCenter.add` forwards conversation messages.
- `src/world/activity.py`: joint and public activities move NPCs; solo activities move NPCs or build.
- `src/agents/data_manager.py`: the solo prompt gains the blueprint list when Minecraft is on.
- `src/world/locations.py`: `LocationStore.add_object`.
- `config.example.json`: `minecraft` section (disabled).

**Java mod (new, `minecraft/agentopia-mc/`)**, package `com.agentopia.mc`:
- `AgentopiaMod`, `Config`, `ModState`, `ServerEvents`: wiring.
- `protocol/Protocol`, `protocol/ProtocolException`, `protocol/LineOutbox`: pure.
- `util/Texts`, `time/PhaseClock`: pure.
- `town/Box`, `town/TownLayout`, `town/PlotAllocator`, `town/TownMap`: pure.
- `build/Blueprint`, `build/Blueprints`: pure.
- `town/TownGeometry`, `town/TownBuilder`: Minecraft.
- `npc/AgentEntity`, `npc/WanderInBoxGoal`, `npc/AgentRegistry`, `npc/Bubbles`: Minecraft.
- `build/BuildExecutor`: Minecraft.
- `bridge/BridgeServer`, `bridge/CommandHandler`: Minecraft.
- `camera/CameraToggle`, `net/Net`, `net/ToggleCameraPacket`: Minecraft.
- `command/AgentopiaCommand`: Minecraft.
- `client/ClientSetup`, `client/ClientEvents`, `client/AgentRenderer`, `client/Keys`: client only.
- Tests in `src/test/java/com/agentopia/mc/...`.

**Server and launchers (new)**
- `minecraft/server/` (git-ignored except `server.properties` and `user_jvm_args.txt`), `START-MC-SERVER.bat`, and `.gitignore` entries.

---

### Task 1: Blueprint catalog (Python)

**Files:**
- Create: `src/minecraft/__init__.py`, `src/minecraft/blueprints.py`
- Create: `tests/__init__.py`, `tests/minecraft/__init__.py`, `tests/minecraft/test_blueprints.py`

**Interfaces:**
- Produces: `Blueprint(id: str, name: str, description: str, cost: int, uses_plot: bool = True)` (frozen dataclass); `BLUEPRINTS: dict[str, Blueprint]`; `prompt_text() -> str`.

- [ ] **Step 1: Write the failing test**

Create `tests/__init__.py` and `tests/minecraft/__init__.py`, both empty, and `src/minecraft/__init__.py` (empty). Then create `tests/minecraft/test_blueprints.py`:

```python
import unittest

from src.minecraft.blueprints import BLUEPRINTS, prompt_text


class BlueprintCatalogTest(unittest.TestCase):
    def test_ids_and_costs_match_the_spec(self):
        self.assertEqual(
            {k: v.cost for k, v in BLUEPRINTS.items()},
            {"garden": 60, "bench_lamp": 40, "mural": 80,
             "room_upgrade": 120, "market_stall": 150, "shed": 200},
        )

    def test_only_room_upgrade_skips_the_plot(self):
        self.assertEqual([k for k, v in BLUEPRINTS.items() if not v.uses_plot], ["room_upgrade"])

    def test_prompt_lists_every_blueprint_with_cost_and_syntax(self):
        text = prompt_text()
        self.assertIn('<role_action>build(blueprint="garden", near="home")</role_action>', text)
        for bp in BLUEPRINTS.values():
            self.assertIn(f"- {bp.id}:", text)
            self.assertIn(f"${bp.cost}", text)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run (repo root): `.venv/Scripts/python.exe -m unittest tests.minecraft.test_blueprints -v`
Expected: ERROR `ModuleNotFoundError: No module named 'src.minecraft.blueprints'`

- [ ] **Step 3: Write minimal implementation**

`src/minecraft/blueprints.py`:

```python
"""Buildable structures. Ids and costs must match build/Blueprints.java in the mod."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Blueprint:
    id: str
    name: str
    description: str
    cost: int
    uses_plot: bool = True


BLUEPRINTS: dict[str, Blueprint] = {
    b.id: b
    for b in (
        Blueprint("garden", "Garden patch", "a fenced flower garden", 60),
        Blueprint("bench_lamp", "Bench and lamp post", "a bench between two lamp posts", 40),
        Blueprint("mural", "Mural wall", "a colourful painted wall", 80),
        Blueprint("room_upgrade", "Upgrade my room", "new furniture in your own room", 120, uses_plot=False),
        Blueprint("market_stall", "Market stall", "a covered stall with crates", 150),
        Blueprint("shed", "Small shed", "a small wooden shed", 200),
    )
}


def prompt_text() -> str:
    """Extra solo-activity instructions shown only when Minecraft is enabled."""
    lines = [
        "## Building in the neighborhood (optional)",
        "You may spend this time building something real in the neighborhood, paid for from your "
        "savings. To do so, describe it in your Activity and add exactly one line:",
        '<role_action>build(blueprint="garden", near="home")</role_action>',
        '`near` is "home" or the name of a public place. Available blueprints:',
    ]
    for b in BLUEPRINTS.values():
        where = ' (inside your own room; use near="home")' if not b.uses_plot else ""
        lines.append(f"- {b.id}: {b.name}, {b.description}, costs ${b.cost}{where}")
    return "\n".join(lines)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_blueprints -v`
Expected: 3 tests, OK

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/__init__.py src/minecraft/blueprints.py tests/__init__.py tests/minecraft/__init__.py tests/minecraft/test_blueprints.py
git commit -m "Add Minecraft blueprint catalog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bridge client (Python)

**Files:**
- Create: `src/minecraft/bridge.py`
- Create: `tests/minecraft/fake_mod.py`, `tests/minecraft/test_bridge.py`

**Interfaces:**
- Produces:
  - `PROTOCOL_VERSION = 1`
  - `class BridgeUnavailable(Exception)`
  - `MinecraftBridge(host="127.0.0.1", port=8770, reply_timeout=5.0, connect_timeout=2.0)` with:
    - `.connected -> bool` (property)
    - `.blueprints: list[str]`
    - `.connect() -> dict` (raises `BridgeUnavailable`)
    - `.request(cmd: str, timeout: float | None = None, **fields) -> dict` (the reply dict, which may have `ok: False`; raises `BridgeUnavailable`)
    - `.wait_event(match: Callable[[dict], bool], timeout: float) -> dict | None`
    - `.add_listener(fn: Callable[[dict], None])`
    - `.close()`
  - Test helper `FakeMod(handlers: dict[str, Callable[[dict], dict | None]] | None)` with `.port`, `.requests`, `.emit(event, **fields)`, `.send_raw(text)`, `.drop_client()`, `.close()`.

- [ ] **Step 1: Write the fake mod and the failing tests**

`tests/minecraft/fake_mod.py`:

```python
"""In-process stand-in for the agentopia-mc bridge, used by tests."""
from __future__ import annotations

import json
import socket
import threading
from typing import Callable


class FakeMod:
    def __init__(self, handlers: dict[str, Callable[[dict], dict | None]] | None = None) -> None:
        self.handlers: dict[str, Callable[[dict], dict | None]] = {
            "hello": lambda req: {"ok": True, "version": 1, "blueprints": ["garden"]},
        }
        self.handlers.update(handlers or {})
        self.requests: list[dict] = []
        self._srv = socket.create_server(("127.0.0.1", 0))
        self.port = self._srv.getsockname()[1]
        self._conn: socket.socket | None = None
        self._lock = threading.Lock()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return
            self._conn = conn
            try:
                with conn.makefile("r", encoding="utf-8") as f:
                    for line in f:
                        req = json.loads(line)
                        self.requests.append(req)
                        handler = self.handlers.get(req["cmd"], lambda r: {"ok": True})
                        reply = handler(req)
                        if reply is not None:
                            self.send({"id": req["id"], **reply})
            except (OSError, ValueError):
                pass

    def send(self, msg: dict) -> None:
        self.send_raw(json.dumps(msg, ensure_ascii=False))

    def send_raw(self, text: str) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.sendall((text + "\n").encode("utf-8"))

    def emit(self, event: str, **fields) -> None:
        self.send({"event": event, **fields})

    def drop_client(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

    def close(self) -> None:
        self.drop_client()
        self._srv.close()
```

`tests/minecraft/test_bridge.py`:

```python
import socket
import threading
import time
import unittest

from src.minecraft.bridge import BridgeUnavailable, MinecraftBridge
from tests.minecraft.fake_mod import FakeMod


def wait_until(cond, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return False


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.mod = FakeMod({"echo": lambda req: {"ok": True, "agent": req["agent"]}})
        self.bridge = MinecraftBridge("127.0.0.1", self.mod.port, reply_timeout=1.0)

    def tearDown(self):
        self.bridge.close()
        self.mod.close()

    def test_connect_handshake_reads_blueprints(self):
        reply = self.bridge.connect()
        self.assertTrue(reply["ok"])
        self.assertTrue(self.bridge.connected)
        self.assertEqual(self.bridge.blueprints, ["garden"])
        self.assertEqual(self.mod.requests[0]["cmd"], "hello")
        self.assertEqual(self.mod.requests[0]["version"], 1)

    def test_request_round_trip_with_non_ascii_names(self):
        self.bridge.connect()
        reply = self.bridge.request("echo", agent="Étienne Bellamy")
        self.assertEqual(reply["agent"], "Étienne Bellamy")

    def test_unreachable_raises(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        free_port = s.getsockname()[1]
        s.close()
        with self.assertRaises(BridgeUnavailable):
            MinecraftBridge("127.0.0.1", free_port, connect_timeout=0.5).connect()

    def test_reply_timeout_raises(self):
        self.mod.handlers["slow"] = lambda req: None
        self.bridge.connect()
        with self.assertRaises(BridgeUnavailable):
            self.bridge.request("slow", timeout=0.2)

    def test_request_before_connect_raises(self):
        with self.assertRaises(BridgeUnavailable):
            self.bridge.request("echo", agent="x")

    def test_wait_event_returns_event_sent_before_waiting(self):
        self.bridge.connect()
        self.mod.emit("build_done", job="b1")
        self.mod.emit("build_done", job="b2")
        evt = self.bridge.wait_event(lambda e: e.get("job") == "b2", timeout=1.0)
        self.assertEqual(evt["job"], "b2")
        self.assertIsNone(self.bridge.wait_event(lambda e: e.get("job") == "b2", timeout=0.1))

    def test_listeners_receive_events(self):
        got = []
        self.bridge.add_listener(got.append)
        self.bridge.connect()
        self.mod.emit("arrived", agent="Leo")
        self.assertTrue(wait_until(lambda: got))
        self.assertEqual(got[0]["agent"], "Leo")

    def test_malformed_line_is_ignored(self):
        self.mod.handlers["noisy"] = lambda req: (self.mod.send_raw("not json {"), {"ok": True})[1]
        self.bridge.connect()
        self.assertTrue(self.bridge.request("noisy")["ok"])

    def test_disconnect_then_reconnect(self):
        self.bridge.connect()
        self.mod.drop_client()
        self.assertTrue(wait_until(lambda: not self.bridge.connected))
        with self.assertRaises(BridgeUnavailable):
            self.bridge.request("echo", agent="x")
        self.bridge.connect()
        self.assertEqual(self.bridge.request("echo", agent="y")["agent"], "y")

    def test_version_mismatch_refuses_connection(self):
        self.mod.handlers["hello"] = lambda req: {"ok": True, "version": 99}
        with self.assertRaises(BridgeUnavailable):
            self.bridge.connect()
        self.assertFalse(self.bridge.connected)

    def test_concurrent_requests_get_their_own_replies(self):
        self.bridge.connect()
        results = {}

        def worker(name):
            results[name] = self.bridge.request("echo", agent=name)["agent"]

        threads = [threading.Thread(target=worker, args=(f"a{i}",)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, {f"a{i}": f"a{i}" for i in range(20)})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_bridge -v`
Expected: ERROR `No module named 'src.minecraft.bridge'`

- [ ] **Step 3: Write the implementation**

`src/minecraft/bridge.py`:

```python
"""Client for the agentopia-mc mod's localhost bridge (JSON lines over TCP).

Replies are matched to requests by id; events (lines with an "event" key) are
buffered for wait_event() and passed to listeners on the reader thread.
"""
from __future__ import annotations

import collections
import itertools
import json
import logging
import socket
import threading
import time
from typing import Any, Callable

PROTOCOL_VERSION = 1
log = logging.getLogger("agentopia.minecraft")


class BridgeUnavailable(Exception):
    """The mod cannot be reached, dropped the connection, or did not answer in time."""


class _Pending:
    __slots__ = ("event", "reply")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.reply: dict | None = None


class MinecraftBridge:
    def __init__(self, host: str = "127.0.0.1", port: int = 8770,
                 reply_timeout: float = 5.0, connect_timeout: float = 2.0) -> None:
        self.host = host
        self.port = port
        self.reply_timeout = reply_timeout
        self.connect_timeout = connect_timeout
        self.blueprints: list[str] = []
        self._sock: socket.socket | None = None
        self._connected = False
        self._ids = itertools.count(1)
        self._pending: dict[int, _Pending] = {}
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._events: collections.deque[dict] = collections.deque(maxlen=500)
        self._event_cv = threading.Condition()
        self._listeners: list[Callable[[dict], None]] = []

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> dict:
        self.close()
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.connect_timeout)
        except OSError as e:
            raise BridgeUnavailable(f"cannot reach Minecraft at {self.host}:{self.port}: {e}") from e
        sock.settimeout(None)
        self._sock = sock
        self._connected = True
        threading.Thread(target=self._read_loop, args=(sock,), name="mc-bridge-reader", daemon=True).start()
        reply = self.request("hello", version=PROTOCOL_VERSION)
        if not reply.get("ok") or reply.get("version") != PROTOCOL_VERSION:
            self.close()
            raise BridgeUnavailable(f"protocol mismatch: {reply}")
        self.blueprints = list(reply.get("blueprints", []))
        return reply

    def request(self, cmd: str, timeout: float | None = None, **fields: Any) -> dict:
        sock = self._sock
        if not self._connected or sock is None:
            raise BridgeUnavailable("not connected")
        rid = next(self._ids)
        slot = _Pending()
        with self._lock:
            self._pending[rid] = slot
        line = json.dumps({"id": rid, "cmd": cmd, **fields}, ensure_ascii=False) + "\n"
        try:
            with self._send_lock:
                sock.sendall(line.encode("utf-8"))
        except OSError as e:
            self._drop(sock)
            raise BridgeUnavailable(f"send failed: {e}") from e
        answered = slot.event.wait(self.reply_timeout if timeout is None else timeout)
        with self._lock:
            self._pending.pop(rid, None)
        if not answered:
            raise BridgeUnavailable(f"no reply to {cmd} in time")
        if slot.reply is None:
            raise BridgeUnavailable("connection lost")
        return slot.reply

    def wait_event(self, match: Callable[[dict], bool], timeout: float) -> dict | None:
        """Return (and consume) the first buffered or future event matching `match`."""
        deadline = time.monotonic() + timeout
        with self._event_cv:
            while True:
                for evt in self._events:
                    if match(evt):
                        self._events.remove(evt)
                        return evt
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._connected:
                    return None
                self._event_cv.wait(remaining)

    def add_listener(self, fn: Callable[[dict], None]) -> None:
        self._listeners.append(fn)

    def close(self) -> None:
        sock = self._sock
        if sock is not None:
            self._drop(sock)

    def _drop(self, sock: socket.socket) -> None:
        try:
            sock.close()
        except OSError:
            pass
        if sock is not self._sock:
            return  # an older connection; a newer one is active
        self._connected = False
        self._sock = None
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for p in pending:
            p.event.set()
        with self._event_cv:
            self._event_cv.notify_all()

    def _read_loop(self, sock: socket.socket) -> None:
        try:
            with sock.makefile("r", encoding="utf-8", newline="\n") as f:
                for raw in f:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        log.warning("ignoring malformed line from Minecraft: %.200s", raw)
                        continue
                    if not isinstance(msg, dict):
                        continue
                    if "event" in msg:
                        with self._event_cv:
                            self._events.append(msg)
                            self._event_cv.notify_all()
                        for fn in list(self._listeners):
                            try:
                                fn(msg)
                            except Exception:
                                log.exception("Minecraft event listener failed")
                    elif "id" in msg:
                        with self._lock:
                            slot = self._pending.get(msg["id"])
                        if slot is not None:
                            slot.reply = msg
                            slot.event.set()
        except (OSError, ValueError):
            pass
        finally:
            self._drop(sock)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_bridge -v`
Expected: 11 tests, OK

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/bridge.py tests/minecraft/fake_mod.py tests/minecraft/test_bridge.py
git commit -m "Add localhost bridge client for the Minecraft mod" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Minecraft hooks core (Python)

**Files:**
- Create: `src/minecraft/hooks.py`
- Create: `tests/minecraft/test_hooks.py`

**Interfaces:**
- Consumes: `BLUEPRINTS`, `prompt_text` (Task 1); `MinecraftBridge` and `BridgeUnavailable` (Task 2).
- Produces:
  - `BuildRequest(blueprint: str, near: str)` and `BuildResult(ok: bool, text: str, cost: int, place: str | None = None)`, both frozen dataclasses.
  - `parse_build_action(text: str | None) -> BuildRequest | None`
  - `class MinecraftHooks(bridge, *, places: dict[str, str], build_timeout: float = 240.0, record_build: Callable[[str, str], None] | None = None)` with methods:
    - `set_agents(agents: list[dict])`
    - `ensure_connected() -> bool`
    - `resolve_place(text: str | None) -> str | None`
    - `phase(year: int, week: int, stage: str, day: int = 0, slot: int = 0)`
    - `contact_message(msg: dict)`
    - `activity_start(agent_names: list[str], location: str | None)`
    - `request_build(agent: str, blueprint_id: str, near: str, deposit: int) -> BuildResult`
    - `handle_event(evt: dict)`
  - Module adapters (wired in Task 4): `attach(world)`, `enabled() -> bool`, `on_phase(world)`, `on_contact_message(msg)`, `on_activity_start(names, location)`, `resolve_place(text)`, `solo_build(action_text) -> BuildRequest | None`, `request_build(agent, blueprint, near, deposit) -> BuildResult`, `solo_prompt_addition() -> str`.

- [ ] **Step 1: Write the failing tests**

`tests/minecraft/test_hooks.py`:

```python
import unittest

from src.minecraft import hooks
from src.minecraft.bridge import BridgeUnavailable
from src.minecraft.hooks import BuildRequest, MinecraftHooks, parse_build_action

PLACES = {"Corner Coffee Shop": "medium", "Coffee Shop Annex": "small",
          "The Rooftop": "large", "Obsidian Network HQ": "hq"}


class FakeBridge:
    def __init__(self, replies=None, events=None, connectable=True):
        self.connected = False
        self.calls = []
        self.replies = replies or {}
        self.events = list(events or [])
        self.connectable = connectable
        self.listeners = []

    def connect(self):
        if not self.connectable:
            raise BridgeUnavailable("down")
        self.connected = True
        return {"ok": True, "version": 1}

    def request(self, cmd, timeout=None, **fields):
        if not self.connected:
            raise BridgeUnavailable("not connected")
        self.calls.append((cmd, fields))
        r = self.replies.get(cmd, {"ok": True})
        return r(fields) if callable(r) else r

    def wait_event(self, match, timeout):
        for e in self.events:
            if match(e):
                return e
        return None

    def add_listener(self, fn):
        self.listeners.append(fn)

    def cmds(self):
        return [c for c, _ in self.calls]


def make(bridge=None, record=None):
    b = bridge or FakeBridge()
    h = MinecraftHooks(b, places=PLACES, build_timeout=0.1, record_build=record)
    h.set_agents([{"name": "Amara Okafor", "faction": ""}, {"name": "Leo", "faction": "thai_guardians"}])
    return h, b


class ParseBuildActionTest(unittest.TestCase):
    def test_double_and_single_quotes(self):
        self.assertEqual(parse_build_action('x <role_action>build(blueprint="garden", near="The Rooftop")</role_action>'),
                         BuildRequest("garden", "The Rooftop"))
        self.assertEqual(parse_build_action("<role_action> build(blueprint='shed') </role_action>"),
                         BuildRequest("shed", "home"))

    def test_absent_or_empty(self):
        self.assertIsNone(parse_build_action("Activity: I read a book."))
        self.assertIsNone(parse_build_action('<role_action>build(near="home")</role_action>'))
        self.assertIsNone(parse_build_action(None))


class ResolvePlaceTest(unittest.TestCase):
    def test_longest_case_insensitive_match_wins(self):
        h, _ = make()
        self.assertEqual(h.resolve_place("meet at the coffee shop annex later"), "Coffee Shop Annex")
        self.assertEqual(h.resolve_place("CORNER COFFEE SHOP"), "Corner Coffee Shop")

    def test_unmatched_or_empty_is_none(self):
        h, _ = make()
        self.assertIsNone(h.resolve_place("a quiet bench downtown"))
        self.assertIsNone(h.resolve_place(None))
        self.assertIsNone(h.resolve_place(""))


class PhaseTest(unittest.TestCase):
    def test_first_phase_connects_syncs_and_sets_phase(self):
        h, b = make()
        h.phase(2020, 1, "plan")
        self.assertEqual(b.cmds(), ["sync_agents", "set_phase"])
        sync = b.calls[0][1]
        self.assertEqual(sync["agents"][1], {"name": "Leo", "faction": "thai_guardians"})
        self.assertIn({"name": "Obsidian Network HQ", "size": "hq"}, sync["places"])
        self.assertEqual(b.calls[1][1], {"year": 2020, "week": 1, "stage": "plan", "day": 0, "slot": 0, "send_home": True})

    def test_contact_does_not_send_home(self):
        h, b = make()
        h.phase(2020, 1, "contact", slot=3)
        self.assertEqual(b.calls[-1][1]["send_home"], False)
        self.assertEqual(b.calls[-1][1]["slot"], 3)

    def test_unavailable_is_silent(self):
        h, b = make(FakeBridge(connectable=False))
        h.phase(2020, 1, "plan")
        self.assertEqual(b.calls, [])

    def test_phase_reconnects_and_resyncs(self):
        h, b = make()
        h.phase(2020, 1, "plan")
        b.connected = False
        h.phase(2020, 1, "before_contact")
        self.assertEqual(b.cmds(), ["sync_agents", "set_phase", "sync_agents", "set_phase"])


class ContactTest(unittest.TestCase):
    def test_contact_message_moves_and_says(self):
        h, b = make()
        h.ensure_connected()
        h.contact_message({"from": "Amara Okafor", "to": "Leo", "type": "contact", "message": "Coffee?"})
        self.assertEqual(b.calls[-2], ("move", {"agent": "Amara Okafor", "target_agent": "Leo"}))
        self.assertEqual(b.calls[-1], ("say", {"agent": "Amara Okafor", "to": "Leo", "text": "Coffee?"}))

    def test_proposal_without_message_gets_generated_text(self):
        h, b = make()
        h.ensure_connected()
        h.contact_message({"from": "Leo", "invited_persons": ["Amara Okafor"], "type": "propose_joint_activity",
                           "activity_name": "Chess", "location": "The Rooftop", "message": ""})
        self.assertEqual(b.calls[-1][1]["text"], 'Shall we do "Chess" at The Rooftop?')

    def test_incomplete_message_is_ignored(self):
        h, b = make()
        h.ensure_connected()
        before = len(b.calls)
        h.contact_message({"from": "Leo", "message": "hi"})
        h.contact_message({"to": "Leo", "message": "hi"})
        self.assertEqual(len(b.calls), before)

    def test_not_connected_is_silent(self):
        h, b = make()
        h.contact_message({"from": "Leo", "to": "Amara Okafor", "message": "hi"})
        self.assertEqual(b.calls, [])


class ActivityStartTest(unittest.TestCase):
    def test_activity_start_moves_everyone_to_the_place(self):
        h, b = make()
        h.ensure_connected()
        h.activity_start(["Leo", "Amara Okafor"], "Rooftop drinks at The Rooftop")
        self.assertEqual(b.calls[-2:], [("move", {"agent": "Leo", "place": "The Rooftop"}),
                                        ("move", {"agent": "Amara Okafor", "place": "The Rooftop"})])

    def test_activity_start_unmatched_location_does_nothing(self):
        h, b = make()
        h.ensure_connected()
        before = len(b.calls)
        h.activity_start(["Leo"], "my apartment")
        h.activity_start(["Leo"], None)
        self.assertEqual(len(b.calls), before)


class BuildTest(unittest.TestCase):
    def test_unknown_blueprint(self):
        h, b = make()
        r = h.request_build("Leo", "castle", "home", 5000)
        self.assertFalse(r.ok)
        self.assertEqual(r.cost, 0)
        self.assertIn("castle", r.text)

    def test_cannot_afford_never_reaches_minecraft(self):
        h, b = make()
        r = h.request_build("Leo", "shed", "home", 199)
        self.assertFalse(r.ok)
        self.assertEqual(r.cost, 0)
        self.assertIn("$200", r.text)
        self.assertNotIn("build", b.cmds())

    def test_success_charges_cost_and_names_the_place(self):
        bridge = FakeBridge(replies={"build": {"ok": True, "job": "b1", "plot": 3}},
                            events=[{"event": "build_done", "job": "b1", "agent": "Leo",
                                     "blueprint": "garden", "place": "Corner Coffee Shop"}])
        h, b = make(bridge)
        r = h.request_build("Leo", "garden", "the corner coffee shop", 500)
        self.assertTrue(r.ok)
        self.assertEqual(r.cost, 60)
        self.assertEqual(r.place, "Corner Coffee Shop")
        self.assertIn("next to Corner Coffee Shop", r.text)
        self.assertEqual(b.calls[-1], ("build", {"agent": "Leo", "blueprint": "garden", "near": "Corner Coffee Shop"}))

    def test_room_upgrade_always_targets_home(self):
        bridge = FakeBridge(replies={"build": {"ok": True, "job": "b2"}},
                            events=[{"event": "build_done", "job": "b2"}])
        h, b = make(bridge)
        r = h.request_build("Leo", "room_upgrade", "The Rooftop", 500)
        self.assertEqual(b.calls[-1][1]["near"], "home")
        self.assertIn("in your room", r.text)

    def test_build_rejected_maps_reason_and_charges_nothing(self):
        h, b = make(FakeBridge(replies={"build": {"ok": False, "error": "no_free_plot"}}))
        r = h.request_build("Leo", "garden", "home", 500)
        self.assertFalse(r.ok)
        self.assertEqual(r.cost, 0)
        self.assertIn("no free building plot", r.text)
        h2, _ = make(FakeBridge(replies={"build": {"ok": False, "error": "busy"}}))
        self.assertIn("already busy", h2.request_build("Leo", "garden", "home", 500).text)

    def test_timeout_charges_materials_but_is_not_done(self):
        h, b = make(FakeBridge(replies={"build": {"ok": True, "job": "b9"}}))
        r = h.request_build("Leo", "garden", "home", 500)
        self.assertFalse(r.ok)
        self.assertEqual(r.cost, 60)
        self.assertIn("did not finish", r.text)

    def test_build_failed_event_charges_nothing(self):
        bridge = FakeBridge(replies={"build": {"ok": True, "job": "b3"}},
                            events=[{"event": "build_failed", "job": "b3", "reason": "unknown_agent"}])
        h, _ = make(bridge)
        r = h.request_build("Leo", "garden", "home", 500)
        self.assertFalse(r.ok)
        self.assertEqual(r.cost, 0)

    def test_unavailable_charges_nothing(self):
        h, _ = make(FakeBridge(connectable=False))
        r = h.request_build("Leo", "garden", "home", 500)
        self.assertFalse(r.ok)
        self.assertEqual(r.cost, 0)
        self.assertIn("unreachable", r.text)


class RecordBuildTest(unittest.TestCase):
    def test_build_done_events_are_recorded_on_the_place(self):
        recorded = []
        h, b = make(record=lambda key, text: recorded.append((key, text)))
        self.assertEqual(b.listeners, [h.handle_event])
        h.handle_event({"event": "build_done", "agent": "Amara Okafor", "blueprint": "garden", "place": "Corner Coffee Shop"})
        h.handle_event({"event": "build_done", "agent": "Amara Okafor", "blueprint": "room_upgrade", "place": "home"})
        h.handle_event({"event": "arrived", "agent": "Leo"})
        self.assertEqual(recorded, [("Corner Coffee Shop", "garden patch built by Amara Okafor"),
                                    ("home/Amara Okafor", "upgrade my room built by Amara Okafor")])


class DisabledModuleTest(unittest.TestCase):
    def setUp(self):
        hooks._hooks = None

    def test_adapters_are_no_ops_when_disabled(self):
        self.assertFalse(hooks.enabled())
        self.assertEqual(hooks.solo_prompt_addition(), "")
        self.assertIsNone(hooks.solo_build('<role_action>build(blueprint="garden")</role_action>'))
        self.assertIsNone(hooks.resolve_place("The Rooftop"))
        hooks.on_contact_message({"from": "a", "to": "b", "message": "hi"})
        hooks.on_activity_start(["a"], "The Rooftop")
        self.assertFalse(hooks.request_build("a", "garden", "home", 999).ok)

    def test_adapter_exceptions_never_escape(self):
        class Boom:
            def contact_message(self, msg):
                raise RuntimeError("boom")
        hooks._hooks = Boom()
        hooks.on_contact_message({"from": "a"})  # must not raise
        hooks._hooks = None


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_hooks -v`
Expected: ERROR `No module named 'src.minecraft.hooks'`

- [ ] **Step 3: Write the implementation**

`src/minecraft/hooks.py`:

```python
"""Connects the simulation to the agentopia-mc Minecraft mod.

Everything here is optional: with config["minecraft"]["enabled"] false the
module-level adapters do nothing, and no adapter ever lets an exception escape
into the simulation.
"""
from __future__ import annotations

import functools
import logging
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable

from src.minecraft.blueprints import BLUEPRINTS, prompt_text
from src.minecraft.bridge import BridgeUnavailable, MinecraftBridge

log = logging.getLogger("agentopia.minecraft")

HOME = "home"
SEND_HOME_STAGES = {"plan", "review", "settle"}
_BUILD_RE = re.compile(r"<role_action>\s*build\s*\((.*?)\)\s*</role_action>", re.S | re.I)
_KV_RE = re.compile(r"""(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_REASONS = {
    "no_free_plot": "there was no free building plot left nearby",
    "busy": "you were already busy building something else",
    "unknown_place": "that place could not be found",
    "town_not_ready": "the neighborhood was not ready for building yet",
}


@dataclass(frozen=True)
class BuildRequest:
    blueprint: str
    near: str


@dataclass(frozen=True)
class BuildResult:
    ok: bool
    text: str
    cost: int
    place: str | None = None


def parse_build_action(text: str | None) -> BuildRequest | None:
    if not text:
        return None
    m = _BUILD_RE.search(text)
    if not m:
        return None
    args = {k.lower(): (dq or sq) for k, dq, sq in _KV_RE.findall(m.group(1))}
    blueprint = (args.get("blueprint") or "").strip()
    if not blueprint:
        return None
    return BuildRequest(blueprint, (args.get("near") or "").strip() or HOME)


class MinecraftHooks:
    def __init__(self, bridge: Any, *, places: dict[str, str], build_timeout: float = 240.0,
                 record_build: Callable[[str, str], None] | None = None) -> None:
        self.bridge = bridge
        self.places = dict(places)
        self._match_order = sorted(self.places, key=lambda p: (-len(p), p))
        self.build_timeout = build_timeout
        self.record_build = record_build
        self._agents: list[dict] = []
        self._connect_lock = threading.Lock()
        self._warned = False
        bridge.add_listener(self.handle_event)

    def set_agents(self, agents: list[dict]) -> None:
        self._agents = list(agents)

    # -- connection -------------------------------------------------------
    def _warn_once(self, msg: str) -> None:
        if not self._warned:
            self._warned = True
            log.warning(msg)

    def _call(self, cmd: str, **fields: Any) -> dict | None:
        try:
            reply = self.bridge.request(cmd, **fields)
        except BridgeUnavailable as e:
            self._warn_once(f"Minecraft unavailable ({e}); the simulation continues without it")
            return None
        if not reply.get("ok"):
            log.debug("Minecraft rejected %s: %s", cmd, reply.get("error"))
        return reply

    def ensure_connected(self) -> bool:
        with self._connect_lock:
            if self.bridge.connected:
                return True
            try:
                self.bridge.connect()
            except BridgeUnavailable as e:
                self._warn_once(f"Minecraft unavailable ({e}); the simulation continues without it")
                return False
            places = [{"name": n, "size": s} for n, s in self.places.items()]
            return self._call("sync_agents", agents=self._agents, places=places) is not None

    # -- behaviour --------------------------------------------------------
    def resolve_place(self, text: str | None) -> str | None:
        if not text:
            return None
        low = text.lower()
        for place in self._match_order:
            if place.lower() in low:
                return place
        return None

    def phase(self, year: int, week: int, stage: str, day: int = 0, slot: int = 0) -> None:
        self._warned = False  # warn at most once per phase
        if not self.ensure_connected():
            return
        self._call("set_phase", year=year, week=week, stage=stage, day=day or 0, slot=slot or 0,
                   send_home=stage in SEND_HOME_STAGES)

    def contact_message(self, msg: dict) -> None:
        if not self.bridge.connected:
            return
        sender = msg.get("from")
        recipients = [msg["to"]] if msg.get("to") else [str(x) for x in (msg.get("invited_persons") or [])]
        if not sender or not recipients:
            return
        text = str(msg.get("message") or "").strip()
        if not text and msg.get("activity_name"):
            at = f" at {msg['location']}" if msg.get("location") else ""
            text = f'Shall we do "{msg["activity_name"]}"{at}?'
        if not text:
            return
        self._call("move", agent=sender, target_agent=recipients[0])
        self._call("say", agent=sender, to=", ".join(recipients), text=text)

    def activity_start(self, agent_names: list[str], location: str | None) -> None:
        if not self.bridge.connected:
            return
        place = self.resolve_place(location)
        if place is None:
            return
        for name in agent_names:
            self._call("move", agent=name, place=place)

    def request_build(self, agent: str, blueprint_id: str, near: str, deposit: int) -> BuildResult:
        bp = BLUEPRINTS.get(blueprint_id)
        if bp is None:
            return BuildResult(False, f'(You wanted to build "{blueprint_id}", but no such blueprint exists.)', 0)
        name = bp.name.lower()
        if deposit < bp.cost:
            return BuildResult(False, f"(You wanted to build a {name}, but could not afford the ${bp.cost} of materials.)", 0)
        target = HOME
        if bp.uses_plot and near.strip().lower() not in ("", HOME, "my room", "my home"):
            target = self.resolve_place(near) or HOME
        unreachable = BuildResult(False, "(The build site was unreachable today, so nothing was built.)", 0)
        if not self.ensure_connected():
            return unreachable
        reply = self._call("build", agent=agent, blueprint=bp.id, near=target)
        if reply is None:
            return unreachable
        if not reply.get("ok"):
            why = _REASONS.get(reply.get("error"), "something went wrong at the site")
            return BuildResult(False, f"(You tried to build a {name}, but {why}.)", 0)
        job = reply.get("job")
        evt = self.bridge.wait_event(
            lambda e: e.get("job") == job and e.get("event") in ("build_done", "build_failed"),
            self.build_timeout)
        where = "in your room" if not bp.uses_plot else ("near your home" if target == HOME else f"next to {target}")
        if evt is None:
            return BuildResult(False, f"(You bought materials and started building a {name} {where}, "
                                      f"but did not finish today.)", bp.cost, target)
        if evt.get("event") == "build_failed":
            return BuildResult(False, f"(You tried to build a {name}, but the work could not be completed.)", 0)
        return BuildResult(True, f"(You built a {name} {where}. It now stands in the neighborhood "
                                 f"for everyone to see.)", bp.cost, target)

    def handle_event(self, evt: dict) -> None:
        if evt.get("event") != "build_done" or self.record_build is None:
            return
        agent = evt.get("agent")
        bp = BLUEPRINTS.get(evt.get("blueprint"))
        if not agent or bp is None:
            return
        place = evt.get("place")
        key = f"home/{agent}" if place in (None, "", HOME) else place
        try:
            self.record_build(key, f"{bp.name.lower()} built by {agent}")
        except Exception:
            log.exception("could not record a Minecraft build")


# ---------------------------------------------------------------------------
# Module-level adapters called from the simulation.
# ---------------------------------------------------------------------------
_hooks: MinecraftHooks | None = None


def _safe(default: Any = None):
    def wrap(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception:
                log.exception("Minecraft hook %s failed; continuing without it", fn.__name__)
                return default() if callable(default) else default
        return inner
    return wrap


def enabled() -> bool:
    return _hooks is not None


@_safe()
def attach(world: Any) -> None:
    """Create the hooks for this world if config["minecraft"]["enabled"] is true."""
    global _hooks
    from src.config import get_config

    cfg = (get_config() or {}).get("minecraft") or {}
    if not cfg.get("enabled"):
        _hooks = None
        return
    bridge = MinecraftBridge(str(cfg.get("host", "127.0.0.1")), int(cfg.get("port", 8770)),
                             reply_timeout=float(cfg.get("reply_timeout_s", 5)))
    store = world.location_store
    public_keys, _ = store.list_all()
    places = {k: store.get(k).size for k in public_keys}
    engine = getattr(world, "faction_engine", None)
    factions = engine.state.get("factions", {}) if engine is not None else {}
    member_of: dict[str, str] = {}
    for fid, f in factions.items():
        places[f"{f.get('name', fid)} HQ"] = "hq"
        for m in f.get("members", []):
            member_of[m] = fid
    hooks = MinecraftHooks(bridge, places=places, build_timeout=float(cfg.get("build_timeout_s", 240)),
                           record_build=store.add_object)
    hooks.set_agents([{"name": a.name, "faction": member_of.get(a.name, "")} for a in world.agents])
    _hooks = hooks
    hooks.ensure_connected()


@_safe()
def on_phase(world: Any) -> None:
    if _hooks is None:
        return
    t = world.clock.get_time()
    _hooks.phase(t.year, t.week, t.stage.name.lower(), t.day, t.slot)


@_safe()
def on_contact_message(msg: dict) -> None:
    if _hooks is not None:
        _hooks.contact_message(msg)


@_safe()
def on_activity_start(agent_names: list[str], location: str | None) -> None:
    if _hooks is not None:
        _hooks.activity_start(list(agent_names), location)


@_safe()
def resolve_place(text: str | None) -> str | None:
    return _hooks.resolve_place(text) if _hooks is not None else None


@_safe()
def solo_build(action_text: str | None) -> BuildRequest | None:
    return parse_build_action(action_text) if _hooks is not None else None


@_safe(default=lambda: BuildResult(False, "", 0))
def request_build(agent: str, blueprint: str, near: str, deposit: int) -> BuildResult:
    if _hooks is None:
        return BuildResult(False, "", 0)
    return _hooks.request_build(agent, blueprint, near, deposit)


@_safe(default="")
def solo_prompt_addition() -> str:
    return prompt_text() if _hooks is not None else ""
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_hooks -v`
Expected: all tests OK

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/hooks.py tests/minecraft/test_hooks.py
git commit -m "Add Minecraft hooks: phases, conversations, moves and builds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the hooks into the simulation (Python)

**Files:**
- Modify: `src/world/locations.py` (add `add_object` and a module lock)
- Modify: `src/world/world.py:91-96` (attach), and after each stage log line in `step()` (lines 778, 789, 818, 829, 862, 1021, 1032)
- Modify: `src/world/scheduling.py:400-403` (`MessageCenter.add`)
- Modify: `src/world/activity.py` (`JointActivity.run` near line 277, `SoloActivity.run` after line 832 and inside the normalisation block ending at line 874, `PublicActivity.run` after line 1371)
- Modify: `src/agents/data_manager.py:1365-1368` (solo prompt parts)
- Modify: `config.example.json` (add the `minecraft` section)
- Create: `tests/minecraft/test_locations.py`

**Interfaces:**
- Consumes: the module adapters from Task 3.
- Produces: `LocationStore.add_object(loc_key: str, text: str) -> bool` (False for an unknown key, True if present or added; thread-safe).

- [ ] **Step 1: Write the failing test for `add_object`**

`tests/minecraft/test_locations.py`:

```python
import json
import tempfile
import threading
import unittest
from pathlib import Path

from src.world.locations import LocationStore


class AddObjectTest(unittest.TestCase):
    def make_store(self, root: Path) -> LocationStore:
        store = LocationStore(world_name="unused")
        store.root = root
        store.path = root / "locations.json"
        store.public = {"The Rooftop": {"display_name": "The Rooftop", "size": "large", "description": "", "objects": ["water tower"]}}
        store.private = {"home/Leo": {"owner": "Leo", "display_name": "Leo's Home", "size": "small", "description": "", "objects": []}}
        store.loaded = True
        return store

    def test_adds_once_and_saves(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.make_store(Path(d))
            self.assertTrue(store.add_object("The Rooftop", "garden patch built by Leo"))
            self.assertTrue(store.add_object("The Rooftop", "garden patch built by Leo"))
            self.assertTrue(store.add_object("home/Leo", "upgrade my room built by Leo"))
            saved = json.loads((Path(d) / "locations.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["public"]["The Rooftop"]["objects"], ["water tower", "garden patch built by Leo"])
            self.assertEqual(saved["private"]["home/Leo"]["objects"], ["upgrade my room built by Leo"])

    def test_unknown_key_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.make_store(Path(d))
            self.assertFalse(store.add_object("Obsidian Network HQ", "shed built by Leo"))
            self.assertFalse((Path(d) / "locations.json").exists())

    def test_concurrent_adds_keep_every_object(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.make_store(Path(d))
            threads = [threading.Thread(target=store.add_object, args=("The Rooftop", f"bench {i}")) for i in range(20)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(len(store.public["The Rooftop"]["objects"]), 21)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_locations -v`
Expected: FAIL with `AttributeError: 'LocationStore' object has no attribute 'add_object'`

- [ ] **Step 3: Implement `add_object`**

In `src/world/locations.py`, add `import threading` with the other imports and, below `_store_cache` (search for `_store_cache`), add:

```python
_objects_lock = threading.Lock()
```

Add this method to `LocationStore`, directly after `get_char_home`:

```python
    def add_object(self, loc_key: str, text: str) -> bool:
        """Append an object to a location's list (e.g. something built in Minecraft).

        Returns False if the location does not exist. Safe to call from any thread.
        """
        with _objects_lock:
            self._load_or_create()
            if loc_key in self.public:
                entry = self.public[loc_key]
            elif loc_key in self.private:
                entry = self.private[loc_key]
            else:
                return False
            objects = entry.setdefault("objects", [])
            if text not in objects:
                objects.append(text)
                self._save()
            return True
```

Run: `.venv/Scripts/python.exe -m unittest tests.minecraft.test_locations -v`
Expected: 3 tests OK

- [ ] **Step 4: Wire the world phases**

In `src/world/world.py`, after the faction bootstrap (`self.faction_engine.bootstrap()`, around line 96), add:

```python

        # Optional Minecraft front end (no-op unless config["minecraft"]["enabled"]).
        from src.minecraft import hooks as minecraft_hooks

        minecraft_hooks.attach(self)
```

At the top of `step()` (right after `def step(self) -> None:` and its first import), add:

```python
        from src.minecraft import hooks as minecraft_hooks
```

Then add the line `minecraft_hooks.on_phase(self)` directly after each of these log statements in `step()`, at the same indentation as the log call:
- `self.logger.info(f"== PLAN STAGE == ...")`
- `self.logger.info(f"== BEFORE_CONTACT STAGE == ...")`
- the `self.logger.info(f"== CONTACT STAGE == ...")` inside the slot loop
- `self.logger.info(f"== AFTER CONTACT STAGE == ...")`
- the `self.logger.info(f"== ACTIVITY STAGE == ...")` inside the day loop (after the closing parenthesis of the multi-line call)
- `self.logger.info(f"== REVIEW STAGE == ...")`
- `self.logger.info(f"== SETTLE STAGE == ...")`

That makes 7 `on_phase` calls in total.

- [ ] **Step 5: Wire conversations**

In `src/world/scheduling.py`, replace `MessageCenter.add`:

```python
    def add(self, msg: Dict[str, Any]) -> None:
        """Append a raw message dict to queue."""
        # As required: no processing, no validation
        self._msgs.append(msg)
        # Act the conversation out in Minecraft (no-op when disabled).
        from src.minecraft import hooks as minecraft_hooks

        minecraft_hooks.on_contact_message(msg)
```

- [ ] **Step 6: Wire activities**

In `src/world/activity.py`:

(a) In `JointActivity.run`, directly after `logger = get_verify_logger(feature="joint_activity")`, add:

```python
        from src.minecraft import hooks as minecraft_hooks

        minecraft_hooks.on_activity_start([a.name for a in self.agents], self.schedule.location)
```

(b) In `PublicActivity.run`, directly after `participant_names = [ag.name for ag in self.agents]`, add:

```python
        from src.minecraft import hooks as minecraft_hooks

        minecraft_hooks.on_activity_start(participant_names, self.schedule.location)
```

(c) In `SoloActivity.run`, directly after `activity_content = extract_activity_content(action)` and its `if logger:` block (just before the `# Step 3: Stage 1 - GodModel evaluates activity` comment), add:

```python
        # Minecraft: build for real if the agent asked to, otherwise walk to the
        # place the activity mentions. Both are no-ops when Minecraft is disabled.
        from src.minecraft import hooks as minecraft_hooks

        mc_build = minecraft_hooks.solo_build(action)
        mc_result = None
        if mc_build is not None:
            deposit = int(agent.dm.read_state()["assets"]["deposit"])
            mc_result = minecraft_hooks.request_build(agent.name, mc_build.blueprint, mc_build.near, deposit)
            if mc_result.text:
                activity_content = f"{activity_content}\n\n{mc_result.text}"
        else:
            minecraft_hooks.on_activity_start(
                [agent.name], minecraft_hooks.resolve_place(activity_content)
            )
```

(d) In the same method, inside `if not is_consumption:`, directly after the two lines

```python
            if not isinstance(deltas_or_none.get("gain_items"), list):
                deltas_or_none["gain_items"] = []
```

add, at the same indentation:

```python
            if mc_result is not None and mc_result.cost:
                deltas_or_none["delta_money"] = int(deltas_or_none["delta_money"]) - int(mc_result.cost)
```

- [ ] **Step 7: Wire the solo prompt**

In `src/agents/data_manager.py`, in `activity_prompt`'s `elif activity_type == "solo":` branch, replace

```python
            parts = [
                self.list_schedule(),
                ACTIVITY_PROMPT,
            ]
```

with

```python
            from src.minecraft import hooks as minecraft_hooks

            parts = [
                self.list_schedule(),
                ACTIVITY_PROMPT,
                minecraft_hooks.solo_prompt_addition(),
            ]
```

(The existing join already drops empty parts.)

- [ ] **Step 8: Add the config section**

In `config.example.json`, add this key after `"max_concurrency"` (keep the JSON valid):

```json
  "minecraft": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 8770,
    "reply_timeout_s": 5,
    "build_timeout_s": 240
  },
```

- [ ] **Step 9: Verify nothing broke**

Run: `.venv/Scripts/python.exe -m unittest discover -s tests -t . -v`
Expected: all Minecraft tests OK

Run: `.venv/Scripts/python.exe -c "import json; json.load(open('config.example.json')); import src.world.world, src.world.activity, src.world.scheduling, src.agents.data_manager; print('imports ok')"`
Expected: `imports ok`

- [ ] **Step 10: Commit**

```bash
git add src/world/locations.py src/world/world.py src/world/scheduling.py src/world/activity.py src/agents/data_manager.py config.example.json tests/minecraft/test_locations.py
git commit -m "Call Minecraft hooks from the simulation's phases and activities" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Forge project scaffold and protocol classes (Java)

**Files:**
- Create: `minecraft/agentopia-mc/` (from the Forge 1.20.1-47.4.0 MDK)
- Create: `minecraft/agentopia-mc/gradlew-low.bat`
- Modify: `minecraft/agentopia-mc/gradle.properties`, `minecraft/agentopia-mc/build.gradle`
- Create: `src/main/java/com/agentopia/mc/protocol/Protocol.java`, `ProtocolException.java`, `LineOutbox.java`
- Create: `src/main/java/com/agentopia/mc/util/Texts.java`, `src/main/java/com/agentopia/mc/time/PhaseClock.java`
- Test: `src/test/java/com/agentopia/mc/protocol/ProtocolTest.java`, `LineOutboxTest.java`, `src/test/java/com/agentopia/mc/util/TextsTest.java`, `src/test/java/com/agentopia/mc/time/PhaseClockTest.java`

All Java paths below are relative to `minecraft/agentopia-mc/`.

**Interfaces:**
- Produces:
  - `Protocol.VERSION = 1`
  - `Protocol.Request(int id, String cmd, JsonObject body)` with `String str(String key)` and `int integer(String key, int def)`
  - `Protocol.parse(String line) -> Request` (throws `ProtocolException`)
  - `Protocol.ok(int id, JsonObject extra) -> String`
  - `Protocol.error(int id, String reason) -> String`
  - `Protocol.event(String name, JsonObject fields) -> String`
  - `LineOutbox(int capacity)` with `offer(String) -> boolean`, `take() -> String`, `clear()`, `dropped() -> int`
  - `Texts.shorten(String text, int max) -> String`
  - `Texts.signLines(String text, int width, int maxLines) -> List<String>`
  - `PhaseClock.dayTime(String stage, int slot) -> long`
  - `PhaseClock.hudText(int year, int week, String stage, int day, int slot) -> String`

- [ ] **Step 1: Ask the owner before the heavy first setup**

Tell the owner: "The first Gradle run downloads about 1 GB and decompiles Minecraft, which takes several minutes of high CPU even at low priority. OK to run it now, or should I wait until your local AI is idle?" Do not continue until they say yes.

- [ ] **Step 2: Create the project from the MDK**

Run (PowerShell, repo root):

```powershell
New-Item -ItemType Directory -Force minecraft\agentopia-mc | Out-Null
Invoke-WebRequest https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-mdk.zip -OutFile $env:TEMP\forge-mdk.zip
Expand-Archive $env:TEMP\forge-mdk.zip -DestinationPath minecraft\agentopia-mc -Force
Remove-Item -Recurse -Force minecraft\agentopia-mc\src\main\java\com\example
Get-ChildItem minecraft\agentopia-mc
```

Expected: `build.gradle`, `gradle.properties`, `gradlew.bat`, `settings.gradle` and `src` listed.

- [ ] **Step 3: Configure the mod and the low-resource Gradle settings**

In `gradle.properties`, set these existing keys (keep the others as the MDK has them):

```properties
org.gradle.jvmargs=-Xmx2G
org.gradle.daemon=false
org.gradle.workers.max=2
mod_id=agentopia
mod_name=Agentopia
mod_license=MIT
mod_version=1.0.0
mod_group_id=com.agentopia.mc
mod_authors=Cheeto35
mod_description=Agentopia simulation agents as Minecraft NPCs.
```

If `org.gradle.workers.max` is not already present, add it.

In `build.gradle`, inside the existing `dependencies { ... }` block after the `minecraft "net.minecraftforge:forge:..."` line, add:

```groovy
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'
    testRuntimeOnly 'org.junit.platform:junit-platform-launcher:1.10.2'
```

At the end of `build.gradle`, add:

```groovy
test {
    useJUnitPlatform()
}
```

Create `gradlew-low.bat` (CRLF line endings):

```bat
@echo off
rem Runs Gradle at below-normal CPU priority so it does not compete with the AI.
cd /d "%~dp0"
start "" /b /wait /belownormal cmd /c gradlew.bat %*
```

- [ ] **Step 4: Write the failing tests**

`src/test/java/com/agentopia/mc/protocol/ProtocolTest.java`:

```java
package com.agentopia.mc.protocol;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ProtocolTest {
    @Test
    void parsesRequest() throws Exception {
        Protocol.Request r = Protocol.parse("{\"id\":7,\"cmd\":\"move\",\"agent\":\"Leo\",\"slot\":3}");
        assertEquals(7, r.id());
        assertEquals("move", r.cmd());
        assertEquals("Leo", r.str("agent"));
        assertNull(r.str("place"));
        assertEquals(3, r.integer("slot", 0));
        assertEquals(0, r.integer("day", 0));
    }

    @Test
    void parsesUtf8Names() throws Exception {
        assertEquals("Étienne Bellamy", Protocol.parse("{\"id\":1,\"cmd\":\"say\",\"agent\":\"Étienne Bellamy\"}").str("agent"));
    }

    @Test
    void rejectsGarbage() {
        assertThrows(ProtocolException.class, () -> Protocol.parse("not json"));
        assertThrows(ProtocolException.class, () -> Protocol.parse("[1,2]"));
        assertThrows(ProtocolException.class, () -> Protocol.parse("{\"cmd\":\"x\"}"));
        assertThrows(ProtocolException.class, () -> Protocol.parse("{\"id\":\"abc\",\"cmd\":\"x\"}"));
    }

    @Test
    void repliesAndEvents() {
        JsonObject extra = new JsonObject();
        extra.addProperty("job", "b1");
        JsonObject ok = JsonParser.parseString(Protocol.ok(4, extra)).getAsJsonObject();
        assertEquals(4, ok.get("id").getAsInt());
        assertTrue(ok.get("ok").getAsBoolean());
        assertEquals("b1", ok.get("job").getAsString());

        JsonObject err = JsonParser.parseString(Protocol.error(5, "busy")).getAsJsonObject();
        assertFalse(err.get("ok").getAsBoolean());
        assertEquals("busy", err.get("error").getAsString());

        JsonObject f = new JsonObject();
        f.addProperty("agent", "Leo");
        JsonObject evt = JsonParser.parseString(Protocol.event("arrived", f)).getAsJsonObject();
        assertEquals("arrived", evt.get("event").getAsString());
        assertEquals("Leo", evt.get("agent").getAsString());
        assertFalse(Protocol.event("x", f).contains("\n"));
    }
}
```

`src/test/java/com/agentopia/mc/protocol/LineOutboxTest.java`:

```java
package com.agentopia.mc.protocol;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.junit.jupiter.api.Assertions.*;

class LineOutboxTest {
    @Test
    @Timeout(1)
    void offerNeverBlocksAndCountsDrops() throws Exception {
        LineOutbox box = new LineOutbox(2);
        assertTrue(box.offer("a"));
        assertTrue(box.offer("b"));
        for (int i = 0; i < 1000; i++) assertFalse(box.offer("overflow"));
        assertEquals(1000, box.dropped());
        assertEquals("a", box.take());
        assertTrue(box.offer("c"));
        box.clear();
        assertTrue(box.offer("d"));
        assertEquals("d", box.take());
    }
}
```

`src/test/java/com/agentopia/mc/util/TextsTest.java`:

```java
package com.agentopia.mc.util;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class TextsTest {
    @Test
    void shorten() {
        assertEquals("hello", Texts.shorten("hello", 10));
        assertEquals("hello w…", Texts.shorten("hello world", 8));
        assertEquals("", Texts.shorten(null, 5));
    }

    @Test
    void signLinesWrapOnWords() {
        assertEquals(List.of("Corner Coffee", "Shop"), Texts.signLines("Corner Coffee Shop", 15, 4));
        assertEquals(List.of("Art and Design", "Workshops"), Texts.signLines("Art and Design Workshops", 15, 4));
    }

    @Test
    void signLinesCutLongWordsAndLimitLines() {
        List<String> lines = Texts.signLines("Supercalifragilisticexpialidocious a b c d e f g h i j k l m n o p", 15, 4);
        assertEquals(4, lines.size());
        lines.forEach(l -> assertTrue(l.length() <= 15, l));
    }
}
```

`src/test/java/com/agentopia/mc/time/PhaseClockTest.java`:

```java
package com.agentopia.mc.time;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PhaseClockTest {
    @Test
    void stagesMapToTimeOfDay() {
        assertEquals(18000L, PhaseClock.dayTime("plan", 0));
        assertEquals(23000L, PhaseClock.dayTime("before_contact", 0));
        assertEquals(0L, PhaseClock.dayTime("contact", 1));
        assertEquals(4000L, PhaseClock.dayTime("contact", 5));
        assertEquals(6000L, PhaseClock.dayTime("activity", 0));
        assertEquals(12000L, PhaseClock.dayTime("review", 0));
        assertEquals(13000L, PhaseClock.dayTime("settle", 0));
        assertEquals(6000L, PhaseClock.dayTime("something_new", 0));
    }

    @Test
    void hudText() {
        assertEquals("Year 2020 · Week 2 · Talk round 3", PhaseClock.hudText(2020, 2, "contact", 0, 3));
        assertEquals("Year 2020 · Week 2 · Activity day 4", PhaseClock.hudText(2020, 2, "activity", 4, 0));
        assertEquals("Year 2021 · Week 1 · Plan", PhaseClock.hudText(2021, 1, "plan", 0, 0));
    }
}
```

- [ ] **Step 5: Run the tests to verify they fail (first Gradle run, the heavy one)**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat test`
Expected: setup completes, then compilation FAILS with `cannot find symbol: class Protocol` (and the others).

- [ ] **Step 6: Write the implementations**

`src/main/java/com/agentopia/mc/protocol/ProtocolException.java`:

```java
package com.agentopia.mc.protocol;

public class ProtocolException extends Exception {
    public ProtocolException(String message) {
        super(message);
    }
}
```

`src/main/java/com/agentopia/mc/protocol/Protocol.java`:

```java
package com.agentopia.mc.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** Newline-delimited JSON messages shared with the Python sim (src/minecraft/bridge.py). */
public final class Protocol {
    public static final int VERSION = 1;

    private Protocol() {}

    public record Request(int id, String cmd, JsonObject body) {
        public String str(String key) {
            JsonElement e = body.get(key);
            return e == null || e.isJsonNull() ? null : e.getAsString();
        }

        public int integer(String key, int def) {
            JsonElement e = body.get(key);
            try {
                return e == null || e.isJsonNull() ? def : e.getAsInt();
            } catch (RuntimeException ex) {
                return def;
            }
        }

        public boolean bool(String key) {
            JsonElement e = body.get(key);
            return e != null && e.isJsonPrimitive() && e.getAsBoolean();
        }
    }

    public static Request parse(String line) throws ProtocolException {
        JsonObject o;
        try {
            o = JsonParser.parseString(line).getAsJsonObject();
        } catch (RuntimeException e) {
            throw new ProtocolException("not a JSON object");
        }
        if (!o.has("id") || !o.has("cmd")) throw new ProtocolException("missing id or cmd");
        try {
            return new Request(o.get("id").getAsInt(), o.get("cmd").getAsString(), o);
        } catch (RuntimeException e) {
            throw new ProtocolException("bad id or cmd");
        }
    }

    public static String ok(int id, JsonObject extra) {
        JsonObject o = extra == null ? new JsonObject() : extra.deepCopy();
        o.addProperty("id", id);
        o.addProperty("ok", true);
        return o.toString();
    }

    public static String error(int id, String reason) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("ok", false);
        o.addProperty("error", reason);
        return o.toString();
    }

    public static String event(String name, JsonObject fields) {
        JsonObject o = fields == null ? new JsonObject() : fields.deepCopy();
        o.addProperty("event", name);
        return o.toString();
    }
}
```

`src/main/java/com/agentopia/mc/protocol/LineOutbox.java`:

```java
package com.agentopia.mc.protocol;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Bounded queue of outgoing lines. offer() never blocks, so the Minecraft
 * server thread can never stall on a slow or paused sim; overflow is dropped.
 */
public final class LineOutbox {
    private final ArrayBlockingQueue<String> queue;
    private final AtomicInteger dropped = new AtomicInteger();

    public LineOutbox(int capacity) {
        this.queue = new ArrayBlockingQueue<>(capacity);
    }

    public boolean offer(String line) {
        boolean accepted = queue.offer(line);
        if (!accepted) dropped.incrementAndGet();
        return accepted;
    }

    public String take() throws InterruptedException {
        return queue.take();
    }

    public void clear() {
        queue.clear();
    }

    public int dropped() {
        return dropped.get();
    }
}
```

`src/main/java/com/agentopia/mc/util/Texts.java`:

```java
package com.agentopia.mc.util;

import java.util.ArrayList;
import java.util.List;

public final class Texts {
    private Texts() {}

    public static String shorten(String text, int max) {
        if (text == null) return "";
        String t = text.strip();
        return t.length() <= max ? t : t.substring(0, max - 1).stripTrailing() + "…";
    }

    /** Word-wraps text for a sign: at most maxLines lines of at most width characters. */
    public static List<String> signLines(String text, int width, int maxLines) {
        List<String> lines = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (String word : (text == null ? "" : text).strip().split("\\s+")) {
            if (word.isEmpty()) continue;
            while (word.length() > width) {
                if (cur.length() > 0) {
                    lines.add(cur.toString());
                    cur.setLength(0);
                }
                lines.add(word.substring(0, width));
                word = word.substring(width);
            }
            if (cur.length() > 0 && cur.length() + 1 + word.length() > width) {
                lines.add(cur.toString());
                cur.setLength(0);
            }
            if (cur.length() > 0) cur.append(' ');
            cur.append(word);
        }
        if (cur.length() > 0) lines.add(cur.toString());
        return lines.size() > maxLines ? new ArrayList<>(lines.subList(0, maxLines)) : lines;
    }
}
```

`src/main/java/com/agentopia/mc/time/PhaseClock.java`:

```java
package com.agentopia.mc.time;

/** Maps the sim's weekly stages to Minecraft time of day and HUD text. */
public final class PhaseClock {
    private PhaseClock() {}

    /** Minecraft day time (0 = 06:00, 6000 = noon, 18000 = midnight). */
    public static long dayTime(String stage, int slot) {
        return switch (stage == null ? "" : stage) {
            case "begin", "plan" -> 18000L;
            case "before_contact" -> 23000L;
            case "contact" -> Math.max(0, slot - 1) * 1000L;
            case "after_contact", "activity" -> 6000L;
            case "review" -> 12000L;
            case "settle" -> 13000L;
            default -> 6000L;
        };
    }

    public static String hudText(int year, int week, String stage, int day, int slot) {
        String phase = switch (stage == null ? "" : stage) {
            case "begin" -> "Start";
            case "plan" -> "Plan";
            case "before_contact" -> "World news";
            case "contact" -> "Talk round " + slot;
            case "after_contact" -> "Arrange";
            case "activity" -> "Activity day " + day;
            case "review" -> "Reflect";
            case "settle" -> "Settle";
            default -> String.valueOf(stage);
        };
        return "Year " + year + " · Week " + week + " · " + phase;
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat test`
Expected: `BUILD SUCCESSFUL`, and ProtocolTest, LineOutboxTest, TextsTest and PhaseClockTest all pass.

- [ ] **Step 8: Ignore build output and commit**

Append to the repo's `.gitignore`:

```gitignore
# Minecraft mod build output and agent server runtime
minecraft/agentopia-mc/build/
minecraft/agentopia-mc/.gradle/
minecraft/agentopia-mc/run/
minecraft/agentopia-mc/runs/
minecraft/server/*
!minecraft/server/server.properties
!minecraft/server/user_jvm_args.txt
```

```bash
git add .gitignore minecraft/agentopia-mc
git commit -m "Scaffold the agentopia-mc Forge mod with protocol and clock classes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Town layout, plots, blueprints and town map (Java, pure)

**Files:**
- Create: `src/main/java/com/agentopia/mc/town/Box.java`, `TownLayout.java`, `PlotAllocator.java`, `TownMap.java`
- Create: `src/main/java/com/agentopia/mc/build/Blueprint.java`, `Blueprints.java`
- Test: `src/test/java/com/agentopia/mc/town/TownLayoutTest.java`, `PlotAllocatorTest.java`, `TownMapTest.java`, `src/test/java/com/agentopia/mc/build/BlueprintsTest.java`

**Interfaces:**
- Produces:
  - `Box(int minX, int minZ, int maxX, int maxZ)` with `centerX()`, `centerZ()`, `intersects(Box)`, `contains(int x, int z)` and `offset(int dx, int dz) -> Box`.
  - `TownLayout.CELL = 16`
  - Records: `TownLayout.PlaceSpec(String name, String size)`, `TownLayout.Cell(int originX, int originZ, String kind)`, `TownLayout.Room(String agent, Box walls, Box interior, int doorX, int doorZ, int standX, int standZ)`, `TownLayout.Building(String name, String kind, Box footprint, int doorX, int doorZ)`, `TownLayout.Plot(int id, Box area, int standX, int standZ)`, `TownLayout.Plan(int side, List<Cell> cells, List<Room> rooms, List<Building> buildings, List<Plot> plots)` with `widthBlocks()`.
  - `TownLayout.footprintSize(String size)` and `TownLayout.plan(List<String> agents, List<PlaceSpec> places, int minPlots)`.
  - `PlotAllocator(List<TownLayout.Plot> plots, Collection<Integer> taken)` with `reserveNearest(int x, int z) -> Optional<Plot>`, `release(int id)`, `freeCount() -> int`.
  - `Blueprint(String id, boolean usesPlot, List<Blueprint.Placement> placements)` and `Blueprint.Placement(int dx, int dy, int dz, String block)`.
  - `Blueprints.ALL: Map<String, Blueprint>` and `Blueprints.COSTS: Map<String, Integer>`.
  - `TownMap` with public fields `agents` (`List<AgentSpec>`), `places`, `generated`, `originX/Y/Z`, `plan`, `plotOwners` (`Map<Integer, String>`) and `builds` (`List<BuildRecord>`).
    - Records `TownMap.AgentSpec(String name, String faction)` and `TownMap.BuildRecord(String owner, String blueprint, String place, Integer plot, int x, int y, int z)`.
    - Methods `load(Path) -> TownMap`, `save(Path)`, `room(String) -> Optional<Room>`, `building(String) -> Optional<Building>`, `factionOf(String) -> String`, `builtPlots() -> Set<Integer>`.

All paths are under `minecraft/agentopia-mc/`.

- [ ] **Step 1: Write the failing tests**

`src/test/java/com/agentopia/mc/town/TownLayoutTest.java`:

```java
package com.agentopia.mc.town;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class TownLayoutTest {
    static List<String> agents(int n) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < n; i++) out.add("Agent " + i);
        return out;
    }

    static List<TownLayout.PlaceSpec> places(int n) {
        List<TownLayout.PlaceSpec> out = new ArrayList<>();
        String[] sizes = {"small", "medium", "large"};
        for (int i = 0; i < n; i++) out.add(new TownLayout.PlaceSpec("Place " + i, sizes[i % 3]));
        out.add(new TownLayout.PlaceSpec("ThAI Guardians HQ", "hq"));
        out.add(new TownLayout.PlaceSpec("Obsidian Network HQ", "hq"));
        return out;
    }

    @Test
    void fullTownForTheApartmentWorld() {
        TownLayout.Plan plan = TownLayout.plan(agents(102), places(31), 60);
        assertEquals(102, plan.rooms().size());
        assertEquals(33, plan.buildings().size());
        assertTrue(plan.plots().size() >= 60);
        assertTrue(plan.side() <= 12, "town must stay within 12x12 chunks");
        assertEquals(plan.side() * 16, plan.widthBlocks());
        assertEquals(2, plan.buildings().stream().filter(b -> b.kind().equals("hq")).count());
    }

    @Test
    void nothingOverlapsAcrossKinds() {
        TownLayout.Plan plan = TownLayout.plan(agents(102), places(31), 60);
        List<Box> solid = new ArrayList<>();
        plan.buildings().forEach(b -> solid.add(b.footprint()));
        plan.plots().forEach(p -> solid.add(p.area()));
        for (int i = 0; i < solid.size(); i++)
            for (int j = i + 1; j < solid.size(); j++)
                assertFalse(solid.get(i).intersects(solid.get(j)), solid.get(i) + " vs " + solid.get(j));
        for (TownLayout.Room r : plan.rooms())
            for (Box b : solid) assertFalse(r.walls().intersects(b), r + " vs " + b);
        Set<String> interiors = new HashSet<>();
        for (TownLayout.Room r : plan.rooms()) {
            for (TownLayout.Room o : plan.rooms())
                if (o != r) assertFalse(r.interior().intersects(o.interior()));
            interiors.add(r.agent());
        }
        assertEquals(102, interiors.size());
    }

    @Test
    void everythingFitsInsideItsCellAndStandSpotsAreOutside() {
        TownLayout.Plan plan = TownLayout.plan(agents(20), places(5), 8);
        int w = plan.widthBlocks();
        for (TownLayout.Plot p : plan.plots()) {
            assertFalse(p.area().contains(p.standX(), p.standZ()));
            assertTrue(p.area().minX() >= 0 && p.area().maxX() < w);
        }
        for (TownLayout.Room r : plan.rooms()) {
            assertFalse(r.walls().contains(r.standX(), r.standZ()));
            assertTrue(r.walls().contains(r.doorX(), r.doorZ()));
        }
        for (TownLayout.Building b : plan.buildings()) {
            assertEquals(b.footprint().maxZ(), b.doorZ());
            int localMin = Math.floorMod(b.footprint().minX(), 16);
            assertTrue(localMin >= 1 && Math.floorMod(b.footprint().maxX(), 16) <= 14);
        }
    }

    @Test
    void footprintSizes() {
        assertEquals(7, TownLayout.footprintSize("small"));
        assertEquals(9, TownLayout.footprintSize("medium"));
        assertEquals(13, TownLayout.footprintSize("large"));
        assertEquals(13, TownLayout.footprintSize("hq"));
        assertEquals(7, TownLayout.footprintSize(null));
    }
}
```

`src/test/java/com/agentopia/mc/town/PlotAllocatorTest.java`:

```java
package com.agentopia.mc.town;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class PlotAllocatorTest {
    static final List<TownLayout.Plot> PLOTS = List.of(
            new TownLayout.Plot(0, new Box(0, 0, 6, 6), 3, -1),
            new TownLayout.Plot(1, new Box(100, 0, 106, 6), 103, -1),
            new TownLayout.Plot(2, new Box(50, 0, 56, 6), 53, -1));

    @Test
    void reservesNearestFree() {
        PlotAllocator a = new PlotAllocator(PLOTS, Set.of());
        assertEquals(1, a.reserveNearest(99, 3).orElseThrow().id());
        assertEquals(2, a.reserveNearest(99, 3).orElseThrow().id());
        assertEquals(1, a.freeCount());
    }

    @Test
    void respectsAlreadyTakenAndRelease() {
        PlotAllocator a = new PlotAllocator(PLOTS, Set.of(0));
        assertEquals(2, a.reserveNearest(0, 0).orElseThrow().id());
        a.release(0);
        assertEquals(0, a.reserveNearest(0, 0).orElseThrow().id());
    }

    @Test
    void plotsExhausted() {
        PlotAllocator a = new PlotAllocator(PLOTS, Set.of(0, 1, 2));
        assertTrue(a.reserveNearest(0, 0).isEmpty());
        assertEquals(0, a.freeCount());
    }
}
```

`src/test/java/com/agentopia/mc/build/BlueprintsTest.java`:

```java
package com.agentopia.mc.build;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class BlueprintsTest {
    @Test
    void idsAndCostsMatchThePythonCatalog() {
        assertEquals(Map.of("garden", 60, "bench_lamp", 40, "mural", 80, "room_upgrade", 120,
                "market_stall", 150, "shed", 200), Blueprints.COSTS);
        assertEquals(Blueprints.COSTS.keySet(), Blueprints.ALL.keySet());
    }

    @Test
    void placementsAreBottomUpAndInBounds() {
        for (Blueprint bp : Blueprints.ALL.values()) {
            int max = bp.usesPlot() ? 6 : 2;
            int lastDy = -1;
            assertFalse(bp.placements().isEmpty(), bp.id());
            for (Blueprint.Placement p : bp.placements()) {
                assertTrue(p.dy() >= lastDy, bp.id() + " not bottom-up");
                lastDy = p.dy();
                assertTrue(p.dx() >= 0 && p.dx() <= max && p.dz() >= 0 && p.dz() <= max, bp.id() + " out of bounds " + p);
                assertTrue(p.dy() >= 0 && p.dy() <= 5);
                assertTrue(p.block().startsWith("minecraft:"));
            }
        }
    }

    @Test
    void roomUpgradeKeepsTheDoorwayTilesFree() {
        for (Blueprint.Placement p : Blueprints.ALL.get("room_upgrade").placements()) {
            if (p.dy() == 0) {
                assertFalse(p.dx() == 1 && (p.dz() == 0 || p.dz() == 2), "blocks a doorway tile: " + p);
            }
        }
        assertFalse(Blueprints.ALL.get("room_upgrade").usesPlot());
    }
}
```

`src/test/java/com/agentopia/mc/town/TownMapTest.java`:

```java
package com.agentopia.mc.town;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class TownMapTest {
    @Test
    void roundTripsThroughJson(@TempDir Path dir) throws Exception {
        TownMap m = new TownMap();
        m.agents = List.of(new TownMap.AgentSpec("Étienne Bellamy", "thai_guardians"));
        m.places = List.of(new TownLayout.PlaceSpec("The Rooftop", "large"));
        m.plan = TownLayout.plan(List.of("Étienne Bellamy"), m.places, 4);
        m.generated = true;
        m.originX = 32; m.originY = -60; m.originZ = 48;
        m.plotOwners.put(2, "Étienne Bellamy");
        m.builds.add(new TownMap.BuildRecord("Étienne Bellamy", "garden", "The Rooftop", 2, 1, 2, 3));
        Path file = dir.resolve("agentopia_town.json");
        m.save(file);

        TownMap back = TownMap.load(file);
        assertTrue(back.generated);
        assertEquals(-60, back.originY);
        assertEquals("thai_guardians", back.factionOf("Étienne Bellamy"));
        assertTrue(back.room("Étienne Bellamy").isPresent());
        assertTrue(back.building("the rooftop").isPresent());
        assertEquals("Étienne Bellamy", back.plotOwners.get(2));
        assertEquals(Set.of(2), back.builtPlots());
    }

    @Test
    void missingOrCorruptFileGivesEmptyMap(@TempDir Path dir) throws Exception {
        assertFalse(TownMap.load(dir.resolve("none.json")).generated);
        Path bad = dir.resolve("bad.json");
        Files.writeString(bad, "{not json");
        assertFalse(TownMap.load(bad).generated);
        assertEquals("", TownMap.load(bad).factionOf("x"));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat test`
Expected: compilation FAILS, `cannot find symbol: class TownLayout`

- [ ] **Step 3: Write the implementations**

`src/main/java/com/agentopia/mc/town/Box.java`:

```java
package com.agentopia.mc.town;

/** Inclusive rectangle on the X/Z plane (town-relative or absolute coordinates). */
public record Box(int minX, int minZ, int maxX, int maxZ) {
    public int centerX() { return (minX + maxX) / 2; }
    public int centerZ() { return (minZ + maxZ) / 2; }

    public boolean intersects(Box o) {
        return minX <= o.maxX && o.minX <= maxX && minZ <= o.maxZ && o.minZ <= maxZ;
    }

    public boolean contains(int x, int z) {
        return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
    }

    public Box offset(int dx, int dz) {
        return new Box(minX + dx, minZ + dz, maxX + dx, maxZ + dz);
    }
}
```

`src/main/java/com/agentopia/mc/town/TownLayout.java`:

```java
package com.agentopia.mc.town;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Pure town planner. The town is a square grid of 16x16 cells (one chunk each);
 * local x=0 and z=0 of every cell are always path, so the cell borders form streets.
 * All coordinates are relative to the town origin.
 */
public final class TownLayout {
    public static final int CELL = 16;

    public record PlaceSpec(String name, String size) {}
    public record Cell(int originX, int originZ, String kind) {}
    public record Room(String agent, Box walls, Box interior, int doorX, int doorZ, int standX, int standZ) {}
    public record Building(String name, String kind, Box footprint, int doorX, int doorZ) {}
    public record Plot(int id, Box area, int standX, int standZ) {}

    public record Plan(int side, List<Cell> cells, List<Room> rooms, List<Building> buildings, List<Plot> plots) {
        public int widthBlocks() { return side * CELL; }
    }

    private TownLayout() {}

    public static int footprintSize(String size) {
        return switch (size == null ? "" : size.toLowerCase(Locale.ROOT)) {
            case "large", "hq" -> 13;
            case "medium" -> 9;
            default -> 7;
        };
    }

    public static Plan plan(List<String> agents, List<PlaceSpec> places, int minPlots) {
        int aptCells = (agents.size() + 5) / 6;
        int plotCells = Math.max(1, (minPlots + 3) / 4);
        List<String> kinds = new ArrayList<>();
        for (int i = 0; i < aptCells; i++) kinds.add("apartments");
        int plotsLeft = plotCells;
        for (int i = 0; i < places.size(); i++) {
            kinds.add("place");
            if (i % 2 == 1 && plotsLeft > 0) {
                kinds.add("plots");
                plotsLeft--;
            }
        }
        for (; plotsLeft > 0; plotsLeft--) kinds.add("plots");
        int side = Math.max(1, (int) Math.ceil(Math.sqrt(kinds.size())));

        List<Cell> cells = new ArrayList<>();
        List<Room> rooms = new ArrayList<>();
        List<Building> buildings = new ArrayList<>();
        List<Plot> plots = new ArrayList<>();
        int agentIdx = 0, placeIdx = 0, plotId = 0;

        for (int i = 0; i < kinds.size(); i++) {
            int ox = (i % side) * CELL, oz = (i / side) * CELL;
            String kind = kinds.get(i);
            cells.add(new Cell(ox, oz, kind));
            switch (kind) {
                case "apartments" -> {
                    // Two rows of three 5x5 rooms (neighbours share a wall) around a corridor at z 6..8.
                    for (int r = 0; r < 6 && agentIdx < agents.size(); r++, agentIdx++) {
                        int row = r / 3, col = r % 3;
                        int x0 = ox + 1 + col * 4, z0 = oz + (row == 0 ? 1 : 9);
                        Box walls = new Box(x0, z0, x0 + 4, z0 + 4);
                        Box interior = new Box(x0 + 1, z0 + 1, x0 + 3, z0 + 3);
                        int doorX = x0 + 2, doorZ = row == 0 ? z0 + 4 : z0;
                        int standZ = row == 0 ? doorZ + 1 : doorZ - 1;
                        rooms.add(new Room(agents.get(agentIdx), walls, interior, doorX, doorZ, doorX, standZ));
                    }
                }
                case "place" -> {
                    PlaceSpec p = places.get(placeIdx++);
                    int w = footprintSize(p.size());
                    int x0 = ox + 1 + (14 - w) / 2, z0 = oz + 1 + (14 - w) / 2;
                    Box fp = new Box(x0, z0, x0 + w - 1, z0 + w - 1);
                    String k = "hq".equalsIgnoreCase(p.size()) ? "hq" : "place";
                    buildings.add(new Building(p.name(), k, fp, fp.centerX(), fp.maxZ()));
                }
                default -> {
                    int[][] offsets = {{1, 1}, {9, 1}, {1, 9}, {9, 9}};
                    for (int[] o : offsets) {
                        Box area = new Box(ox + o[0], oz + o[1], ox + o[0] + 6, oz + o[1] + 6);
                        plots.add(new Plot(plotId++, area, area.minX() + 3, area.minZ() - 1));
                    }
                }
            }
        }
        return new Plan(side, cells, rooms, buildings, plots);
    }
}
```

`src/main/java/com/agentopia/mc/town/PlotAllocator.java`:

```java
package com.agentopia.mc.town;

import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

public final class PlotAllocator {
    private final List<TownLayout.Plot> plots;
    private final Set<Integer> taken;

    public PlotAllocator(List<TownLayout.Plot> plots, Collection<Integer> taken) {
        this.plots = List.copyOf(plots);
        this.taken = new HashSet<>(taken);
    }

    /** Reserves the free plot whose centre is closest to (x, z); ties go to the lower id. */
    public synchronized Optional<TownLayout.Plot> reserveNearest(int x, int z) {
        TownLayout.Plot best = null;
        long bestDist = Long.MAX_VALUE;
        for (TownLayout.Plot p : plots) {
            if (taken.contains(p.id())) continue;
            long dx = p.area().centerX() - x, dz = p.area().centerZ() - z;
            long d = dx * dx + dz * dz;
            if (d < bestDist) {
                bestDist = d;
                best = p;
            }
        }
        if (best != null) taken.add(best.id());
        return Optional.ofNullable(best);
    }

    public synchronized void release(int id) {
        taken.remove(id);
    }

    public synchronized int freeCount() {
        return (int) plots.stream().filter(p -> !taken.contains(p.id())).count();
    }
}
```

`src/main/java/com/agentopia/mc/build/Blueprint.java`:

```java
package com.agentopia.mc.build;

import java.util.List;

/** Blocks placed relative to an origin; dy = 0 is the first block above the ground. */
public record Blueprint(String id, boolean usesPlot, List<Placement> placements) {
    public record Placement(int dx, int dy, int dz, String block) {}
}
```

`src/main/java/com/agentopia/mc/build/Blueprints.java`:

```java
package com.agentopia.mc.build;

import com.agentopia.mc.build.Blueprint.Placement;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Ids and costs must match src/minecraft/blueprints.py in the sim. */
public final class Blueprints {
    public static final Map<String, Integer> COSTS = Map.of(
            "garden", 60, "bench_lamp", 40, "mural", 80, "room_upgrade", 120, "market_stall", 150, "shed", 200);
    public static final Map<String, Blueprint> ALL = build();

    private Blueprints() {}

    private static Map<String, Blueprint> build() {
        Map<String, Blueprint> m = new LinkedHashMap<>();
        m.put("garden", sorted("garden", true, garden()));
        m.put("bench_lamp", sorted("bench_lamp", true, benchLamp()));
        m.put("mural", sorted("mural", true, mural()));
        m.put("room_upgrade", sorted("room_upgrade", false, roomUpgrade()));
        m.put("market_stall", sorted("market_stall", true, marketStall()));
        m.put("shed", sorted("shed", true, shed()));
        return Map.copyOf(m);
    }

    private static Blueprint sorted(String id, boolean usesPlot, List<Placement> list) {
        list.sort(Comparator.comparingInt(Placement::dy).thenComparingInt(Placement::dz).thenComparingInt(Placement::dx));
        return new Blueprint(id, usesPlot, List.copyOf(list));
    }

    private static List<Placement> garden() {
        List<Placement> g = new ArrayList<>();
        String[] flowers = {"minecraft:poppy", "minecraft:dandelion", "minecraft:cornflower"};
        for (int dx = 0; dx <= 6; dx++) {
            for (int dz = 0; dz <= 6; dz++) {
                boolean edge = dx == 0 || dx == 6 || dz == 0 || dz == 6;
                if (edge) g.add(new Placement(dx, 0, dz, dx == 3 && dz == 0 ? "minecraft:oak_fence_gate" : "minecraft:oak_fence"));
                else if (dx == 3 && dz == 3) g.add(new Placement(dx, 0, dz, "minecraft:azalea"));
                else if ((dx + dz) % 2 == 0) g.add(new Placement(dx, 0, dz, flowers[(dx * 7 + dz) % 3]));
            }
        }
        return g;
    }

    private static List<Placement> benchLamp() {
        List<Placement> b = new ArrayList<>();
        for (int dx = 2; dx <= 4; dx++) b.add(new Placement(dx, 0, 3, "minecraft:oak_stairs"));
        for (int dx : new int[]{1, 5}) {
            for (int dy = 0; dy <= 2; dy++) b.add(new Placement(dx, dy, 1, "minecraft:oak_fence"));
            b.add(new Placement(dx, 3, 1, "minecraft:lantern"));
        }
        return b;
    }

    private static List<Placement> mural() {
        List<Placement> m = new ArrayList<>();
        String[] colors = {"minecraft:orange_wool", "minecraft:yellow_wool", "minecraft:red_wool", "minecraft:white_wool"};
        for (int dy = 0; dy <= 5; dy++)
            for (int dx = 0; dx <= 6; dx++)
                m.add(new Placement(dx, dy, 3, dx == 0 || dx == 6 ? "minecraft:spruce_log" : colors[(dx + dy) % 4]));
        return m;
    }

    /** Furniture inside a 3x3 room interior; (1,0) and (1,2) stay free because either may be the doorway. */
    private static List<Placement> roomUpgrade() {
        List<Placement> r = new ArrayList<>();
        r.add(new Placement(0, 0, 0, "minecraft:crafting_table"));
        r.add(new Placement(2, 0, 0, "minecraft:barrel"));
        r.add(new Placement(0, 0, 2, "minecraft:bookshelf"));
        r.add(new Placement(2, 0, 2, "minecraft:bookshelf"));
        r.add(new Placement(1, 0, 1, "minecraft:white_carpet"));
        r.add(new Placement(0, 1, 0, "minecraft:lantern"));
        return r;
    }

    private static List<Placement> marketStall() {
        List<Placement> m = new ArrayList<>();
        int[][] posts = {{1, 2}, {5, 2}, {1, 4}, {5, 4}};
        for (int[] p : posts)
            for (int dy = 0; dy <= 2; dy++) m.add(new Placement(p[0], dy, p[1], "minecraft:oak_fence"));
        for (int dx = 2; dx <= 4; dx++) {
            m.add(new Placement(dx, 0, 2, "minecraft:barrel"));
            m.add(new Placement(dx, 0, 4, "minecraft:barrel"));
        }
        for (int dx = 0; dx <= 6; dx++)
            for (int dz = 1; dz <= 5; dz++)
                m.add(new Placement(dx, 3, dz, dx % 2 == 0 ? "minecraft:red_wool" : "minecraft:white_wool"));
        return m;
    }

    private static List<Placement> shed() {
        List<Placement> s = new ArrayList<>();
        for (int dy = 0; dy <= 2; dy++)
            for (int dx = 1; dx <= 5; dx++)
                for (int dz = 1; dz <= 5; dz++) {
                    boolean wall = dx == 1 || dx == 5 || dz == 1 || dz == 5;
                    boolean door = dx == 3 && dz == 1 && dy <= 1;
                    if (wall && !door) s.add(new Placement(dx, dy, dz, "minecraft:spruce_planks"));
                }
        for (int dx = 0; dx <= 6; dx++)
            for (int dz = 0; dz <= 6; dz++) s.add(new Placement(dx, 3, dz, "minecraft:spruce_slab"));
        return s;
    }
}
```

`src/main/java/com/agentopia/mc/town/TownMap.java`:

```java
package com.agentopia.mc.town;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.mojang.logging.LogUtils;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Everything the mod remembers about the town, saved as agentopia_town.json in the world folder. */
public final class TownMap {
    private static final Logger LOGGER = LogUtils.getLogger();
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public record AgentSpec(String name, String faction) {}
    public record BuildRecord(String owner, String blueprint, String place, Integer plot, int x, int y, int z) {}

    public List<AgentSpec> agents = new ArrayList<>();
    public List<TownLayout.PlaceSpec> places = new ArrayList<>();
    public boolean generated;
    public int originX, originY, originZ;
    public TownLayout.Plan plan;
    public Map<Integer, String> plotOwners = new HashMap<>();
    public List<BuildRecord> builds = new ArrayList<>();

    public static TownMap load(Path file) {
        if (!Files.exists(file)) return new TownMap();
        try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            TownMap m = GSON.fromJson(r, TownMap.class);
            return m == null ? new TownMap() : m.normalized();
        } catch (IOException | RuntimeException e) {
            LOGGER.error("Could not read {}; starting with an empty town map", file, e);
            return new TownMap();
        }
    }

    private TownMap normalized() {
        if (agents == null) agents = new ArrayList<>();
        if (places == null) places = new ArrayList<>();
        if (plotOwners == null) plotOwners = new HashMap<>();
        if (builds == null) builds = new ArrayList<>();
        return this;
    }

    public void save(Path file) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(tmp, GSON.toJson(this), StandardCharsets.UTF_8);
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    public Optional<TownLayout.Room> room(String agent) {
        if (plan == null) return Optional.empty();
        return plan.rooms().stream().filter(r -> r.agent().equals(agent)).findFirst();
    }

    public Optional<TownLayout.Building> building(String place) {
        if (plan == null || place == null) return Optional.empty();
        String p = place.toLowerCase(Locale.ROOT);
        return plan.buildings().stream().filter(b -> b.name().toLowerCase(Locale.ROOT).equals(p)).findFirst();
    }

    public String factionOf(String agent) {
        return agents.stream().filter(a -> a.name().equals(agent)).map(AgentSpec::faction)
                .filter(f -> f != null).findFirst().orElse("");
    }

    public Set<Integer> builtPlots() {
        Set<Integer> out = new HashSet<>();
        for (BuildRecord b : builds) if (b.plot() != null) out.add(b.plot());
        return out;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat test`
Expected: `BUILD SUCCESSFUL`; TownLayoutTest, PlotAllocatorTest, BlueprintsTest, TownMapTest and the Task 5 tests all pass.

- [ ] **Step 5: Commit**

```bash
git add minecraft/agentopia-mc/src
git commit -m "Add town layout, plot allocation, blueprints and town map" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: NPC entity, registry and renderer (Java)

**Files:**
- Create: `src/main/java/com/agentopia/mc/AgentopiaMod.java`, `Config.java`, `ModState.java`
- Create: `src/main/java/com/agentopia/mc/town/TownGeometry.java`
- Create: `src/main/java/com/agentopia/mc/npc/AgentEntity.java`, `WanderInBoxGoal.java`, `AgentRegistry.java`
- Create: `src/main/java/com/agentopia/mc/client/ClientSetup.java`, `AgentRenderer.java`
- Create: `src/main/resources/assets/agentopia/lang/en_us.json`

**Interfaces:**
- Consumes: `TownMap`, `TownLayout`, `Box` (Task 6); `Protocol.event` (Task 5).
- Produces:
  - `AgentopiaMod.MODID = "agentopia"` and `AgentopiaMod.AGENT: RegistryObject<EntityType<AgentEntity>>`
  - `Config.BRIDGE_PORT: ForgeConfigSpec.IntValue` and `Config.SPEC`
  - `ModState` (static):
    - fields `server`, `town`, `townFile`, `bridge` (type `BridgeServer`, added in Task 9), `hudText`
    - `saveTown()`, `emit(String event, JsonObject fields)`, `level() -> ServerLevel`, `now() -> long`
  - `TownGeometry` (static):
    - `abs(TownMap, int x, int z) -> BlockPos`
    - `absBox(TownMap, Box) -> Box`
    - `area(TownMap) -> AABB`
    - `homePos(TownMap, String) -> BlockPos` and `homeBox(TownMap, String) -> Box` (nullable)
    - `center(TownMap) -> BlockPos`
    - `placePos(TownMap, Building) -> BlockPos` and `placeBox(TownMap, Building) -> Box`
  - `AgentEntity` with:
    - `setAgent(String name, ChatFormatting color)`, `getAgentName() -> String`
    - `getWanderBox()` / `setWanderBox(Box)`
    - `isMoving()` / `setMoving(boolean)`
    - `createAttributes()`
  - `AgentRegistry` (static):
    - `sync(ServerLevel, TownMap)`
    - `get(ServerLevel, String) -> Optional<AgentEntity>`
    - `names() -> Set<String>`
    - `moveTo(ServerLevel, String, BlockPos target, Box wander, long now) -> boolean`
    - `tick(ServerLevel, long now)`
    - `color(String faction) -> ChatFormatting`

Note on `ModState.bridge`: declare the field in this task as `public static com.agentopia.mc.bridge.BridgeServer bridge;`, and create a temporary empty `bridge/BridgeServer.java` containing only `public final class BridgeServer { public void send(String line) {} }` so the project compiles. Task 9 replaces it.

- [ ] **Step 1: Write the classes**

`src/main/java/com/agentopia/mc/Config.java`:

```java
package com.agentopia.mc;

import net.minecraftforge.common.ForgeConfigSpec;

public final class Config {
    public static final ForgeConfigSpec SPEC;
    public static final ForgeConfigSpec.IntValue BRIDGE_PORT;

    static {
        ForgeConfigSpec.Builder b = new ForgeConfigSpec.Builder();
        BRIDGE_PORT = b.comment("Localhost port the Agentopia simulation connects to").defineInRange("bridgePort", 8770, 1024, 65535);
        SPEC = b.build();
    }

    private Config() {}
}
```

`src/main/java/com/agentopia/mc/AgentopiaMod.java`:

```java
package com.agentopia.mc;

import com.agentopia.mc.npc.AgentEntity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import net.minecraftforge.event.entity.EntityAttributeCreationEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.ModLoadingContext;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.config.ModConfig;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

@Mod(AgentopiaMod.MODID)
public final class AgentopiaMod {
    public static final String MODID = "agentopia";

    public static final DeferredRegister<EntityType<?>> ENTITIES = DeferredRegister.create(ForgeRegistries.ENTITY_TYPES, MODID);
    public static final RegistryObject<EntityType<AgentEntity>> AGENT = ENTITIES.register("agent",
            () -> EntityType.Builder.<AgentEntity>of(AgentEntity::new, MobCategory.MISC)
                    .sized(0.6F, 1.8F).clientTrackingRange(10).build("agent"));

    public AgentopiaMod() {
        IEventBus modBus = FMLJavaModLoadingContext.get().getModEventBus();
        ENTITIES.register(modBus);
        modBus.addListener(this::onAttributes);
        ModLoadingContext.get().registerConfig(ModConfig.Type.COMMON, Config.SPEC);
    }

    private void onAttributes(EntityAttributeCreationEvent event) {
        event.put(AGENT.get(), AgentEntity.createAttributes().build());
    }
}
```

`src/main/java/com/agentopia/mc/ModState.java`:

```java
package com.agentopia.mc;

import com.agentopia.mc.bridge.BridgeServer;
import com.agentopia.mc.protocol.Protocol;
import com.agentopia.mc.town.TownMap;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.slf4j.Logger;

import java.io.IOException;
import java.nio.file.Path;

/** Server-side state shared by the bridge, commands and tick handlers (server thread only). */
public final class ModState {
    private static final Logger LOGGER = LogUtils.getLogger();

    public static MinecraftServer server;
    public static TownMap town = new TownMap();
    public static Path townFile;
    public static BridgeServer bridge;
    public static volatile String hudText = "";

    private ModState() {}

    public static ServerLevel level() {
        return server.overworld();
    }

    public static long now() {
        return server.getTickCount();
    }

    public static void saveTown() {
        if (townFile == null) return;
        try {
            town.save(townFile);
        } catch (IOException e) {
            LOGGER.error("Could not save the Agentopia town map", e);
        }
    }

    public static void emit(String event, JsonObject fields) {
        if (bridge != null) bridge.send(Protocol.event(event, fields));
    }
}
```

`src/main/java/com/agentopia/mc/town/TownGeometry.java`:

```java
package com.agentopia.mc.town;

import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;

/** Converts town-relative layout coordinates into world positions. */
public final class TownGeometry {
    private TownGeometry() {}

    public static BlockPos abs(TownMap t, int x, int z) {
        return new BlockPos(t.originX + x, t.originY, t.originZ + z);
    }

    public static Box absBox(TownMap t, Box b) {
        return b.offset(t.originX, t.originZ);
    }

    public static AABB area(TownMap t) {
        int w = t.plan == null ? 16 : t.plan.widthBlocks();
        return new AABB(t.originX - 8, t.originY - 4, t.originZ - 8, t.originX + w + 8, t.originY + 24, t.originZ + w + 8);
    }

    /** A street corner in the middle of the town (local cell coordinate 0,0 is always path). */
    public static BlockPos center(TownMap t) {
        int c = (t.plan == null ? 0 : t.plan.side() / 2) * TownLayout.CELL;
        return abs(t, c, c);
    }

    public static BlockPos homePos(TownMap t, String agent) {
        return t.room(agent).map(r -> abs(t, r.interior().centerX(), r.interior().centerZ())).orElseGet(() -> center(t));
    }

    public static Box homeBox(TownMap t, String agent) {
        return t.room(agent).map(r -> absBox(t, r.interior())).orElse(null);
    }

    public static BlockPos placePos(TownMap t, TownLayout.Building b) {
        return abs(t, b.footprint().centerX(), b.footprint().centerZ());
    }

    public static Box placeBox(TownMap t, TownLayout.Building b) {
        Box f = absBox(t, b.footprint());
        return new Box(f.minX() + 1, f.minZ() + 1, f.maxX() - 1, f.maxZ() - 1);
    }
}
```

`src/main/java/com/agentopia/mc/npc/AgentEntity.java`:

```java
package com.agentopia.mc.npc;

import com.agentopia.mc.town.Box;
import net.minecraft.ChatFormatting;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.goal.FloatGoal;
import net.minecraft.world.entity.ai.goal.LookAtPlayerGoal;
import net.minecraft.world.entity.ai.goal.RandomLookAroundGoal;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;

import javax.annotation.Nullable;

/** One simulated agent. Invulnerable, persistent, driven by AgentRegistry. */
public class AgentEntity extends PathfinderMob {
    private String agentName = "";
    @Nullable private Box wanderBox;
    private boolean moving;

    public AgentEntity(EntityType<? extends AgentEntity> type, Level level) {
        super(type, level);
        setPersistenceRequired();
        setInvulnerable(true);
    }

    public static AttributeSupplier.Builder createAttributes() {
        return Mob.createMobAttributes().add(Attributes.MOVEMENT_SPEED, 0.3D).add(Attributes.FOLLOW_RANGE, 64.0D);
    }

    @Override
    protected void registerGoals() {
        goalSelector.addGoal(0, new FloatGoal(this));
        goalSelector.addGoal(5, new WanderInBoxGoal(this));
        goalSelector.addGoal(6, new LookAtPlayerGoal(this, Player.class, 6.0F));
        goalSelector.addGoal(7, new RandomLookAroundGoal(this));
    }

    public void setAgent(String name, ChatFormatting color) {
        agentName = name;
        setCustomName(Component.literal(name).withStyle(color));
        setCustomNameVisible(true);
    }

    public String getAgentName() {
        return agentName;
    }

    @Nullable
    public Box getWanderBox() {
        return wanderBox;
    }

    public void setWanderBox(@Nullable Box box) {
        wanderBox = box;
    }

    public boolean isMoving() {
        return moving;
    }

    public void setMoving(boolean moving) {
        this.moving = moving;
    }

    @Override
    public void addAdditionalSaveData(CompoundTag tag) {
        super.addAdditionalSaveData(tag);
        tag.putString("AgentName", agentName);
    }

    @Override
    public void readAdditionalSaveData(CompoundTag tag) {
        super.readAdditionalSaveData(tag);
        agentName = tag.getString("AgentName");
    }

    @Override
    public boolean removeWhenFarAway(double distanceSq) {
        return false;
    }
}
```

`src/main/java/com/agentopia/mc/npc/WanderInBoxGoal.java`:

```java
package com.agentopia.mc.npc;

import com.agentopia.mc.town.Box;
import net.minecraft.world.entity.ai.goal.Goal;

import java.util.EnumSet;

/** Idle shuffling inside the NPC's current room or building, only when it has no errand. */
public class WanderInBoxGoal extends Goal {
    private final AgentEntity npc;

    public WanderInBoxGoal(AgentEntity npc) {
        this.npc = npc;
        setFlags(EnumSet.of(Flag.MOVE));
    }

    @Override
    public boolean canUse() {
        return !npc.isMoving() && npc.getWanderBox() != null && npc.getNavigation().isDone() && npc.getRandom().nextInt(200) == 0;
    }

    @Override
    public void start() {
        Box b = npc.getWanderBox();
        int x = b.minX() + npc.getRandom().nextInt(b.maxX() - b.minX() + 1);
        int z = b.minZ() + npc.getRandom().nextInt(b.maxZ() - b.minZ() + 1);
        npc.getNavigation().moveTo(x + 0.5D, npc.getY(), z + 0.5D, 0.6D);
    }

    @Override
    public boolean canContinueToUse() {
        return !npc.isMoving() && !npc.getNavigation().isDone();
    }
}
```

`src/main/java/com/agentopia/mc/npc/AgentRegistry.java`:

```java
package com.agentopia.mc.npc;

import com.agentopia.mc.AgentopiaMod;
import com.agentopia.mc.ModState;
import com.agentopia.mc.town.Box;
import com.agentopia.mc.town.TownGeometry;
import com.agentopia.mc.town.TownMap;
import com.google.gson.JsonObject;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.phys.Vec3;

import javax.annotation.Nullable;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** Name -> NPC mapping plus walking with a teleport fallback. Server thread only. */
public final class AgentRegistry {
    private static final Map<String, UUID> IDS = new HashMap<>();
    private static final Map<String, Move> MOVES = new HashMap<>();
    private static final long STUCK_TICKS = 400; // 20 s without getting closer
    private static final double SEGMENT = 48.0;   // keep each pathfinding request short and cheap

    private static final class Move {
        final BlockPos target;
        double best = Double.MAX_VALUE;
        long bestTick;

        Move(BlockPos target, long now) {
            this.target = target;
            this.bestTick = now;
        }
    }

    private AgentRegistry() {}

    public static ChatFormatting color(String faction) {
        return switch (faction == null ? "" : faction) {
            case "thai_guardians" -> ChatFormatting.AQUA;
            case "obsidian_network" -> ChatFormatting.LIGHT_PURPLE;
            default -> ChatFormatting.WHITE;
        };
    }

    /** Spawns NPCs that are missing, removes ones the sim no longer has. Needs a generated town. */
    public static void sync(ServerLevel level, TownMap town) {
        IDS.clear();
        MOVES.clear();
        Set<String> wanted = new HashSet<>();
        town.agents.forEach(a -> wanted.add(a.name()));
        for (AgentEntity e : level.getEntitiesOfClass(AgentEntity.class, TownGeometry.area(town))) {
            if (wanted.contains(e.getAgentName()) && !IDS.containsKey(e.getAgentName())) IDS.put(e.getAgentName(), e.getUUID());
            else e.discard();
        }
        for (TownMap.AgentSpec spec : town.agents) {
            Optional<AgentEntity> existing = get(level, spec.name());
            if (existing.isPresent()) {
                existing.get().setAgent(spec.name(), color(spec.faction()));
                existing.get().setMoving(false);
                existing.get().setWanderBox(TownGeometry.homeBox(town, spec.name()));
                continue;
            }
            AgentEntity e = AgentopiaMod.AGENT.get().create(level);
            if (e == null) continue;
            e.setAgent(spec.name(), color(spec.faction()));
            BlockPos home = TownGeometry.homePos(town, spec.name());
            e.moveTo(home.getX() + 0.5D, home.getY(), home.getZ() + 0.5D, 0.0F, 0.0F);
            e.setWanderBox(TownGeometry.homeBox(town, spec.name()));
            level.addFreshEntity(e);
            IDS.put(spec.name(), e.getUUID());
        }
    }

    public static Optional<AgentEntity> get(ServerLevel level, String name) {
        UUID id = IDS.get(name);
        if (id == null) return Optional.empty();
        return level.getEntity(id) instanceof AgentEntity a ? Optional.of(a) : Optional.empty();
    }

    public static Set<String> names() {
        return Set.copyOf(IDS.keySet());
    }

    public static boolean moveTo(ServerLevel level, String name, BlockPos target, @Nullable Box wander, long now) {
        Optional<AgentEntity> oe = get(level, name);
        if (oe.isEmpty()) return false;
        AgentEntity e = oe.get();
        e.setWanderBox(wander);
        e.setMoving(true);
        MOVES.put(name, new Move(target, now));
        step(e, target);
        return true;
    }

    public static void tick(ServerLevel level, long now) {
        Iterator<Map.Entry<String, Move>> it = MOVES.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Move> en = it.next();
            Move m = en.getValue();
            Optional<AgentEntity> oe = get(level, en.getKey());
            if (oe.isEmpty()) {
                it.remove();
                continue;
            }
            AgentEntity e = oe.get();
            double dist = Math.sqrt(e.distanceToSqr(Vec3.atBottomCenterOf(m.target)));
            if (dist < 1.5D) {
                finish(e, false);
                it.remove();
                continue;
            }
            if (dist < m.best - 1.0D) {
                m.best = dist;
                m.bestTick = now;
            }
            if (now - m.bestTick > STUCK_TICKS) {
                e.teleportTo(m.target.getX() + 0.5D, m.target.getY(), m.target.getZ() + 0.5D);
                finish(e, true);
                it.remove();
                continue;
            }
            if ((now + e.getId()) % 40 == 0) step(e, m.target); // staggered re-path
        }
    }

    private static void step(AgentEntity e, BlockPos target) {
        Vec3 from = e.position();
        Vec3 to = Vec3.atBottomCenterOf(target);
        Vec3 d = to.subtract(from);
        double len = d.horizontalDistance();
        Vec3 goal = len <= SEGMENT ? to : from.add(d.scale(SEGMENT / len));
        e.getNavigation().moveTo(goal.x, to.y, goal.z, 0.7D);
    }

    private static void finish(AgentEntity e, boolean teleported) {
        e.setMoving(false);
        e.getNavigation().stop();
        JsonObject f = new JsonObject();
        f.addProperty("agent", e.getAgentName());
        f.addProperty("teleported", teleported);
        ModState.emit("arrived", f);
    }
}
```

`src/main/java/com/agentopia/mc/client/AgentRenderer.java`:

```java
package com.agentopia.mc.client;

import com.agentopia.mc.npc.AgentEntity;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.client.resources.DefaultPlayerSkin;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Player-shaped NPCs wearing one of Minecraft's built-in default skins, chosen from the name. */
public class AgentRenderer extends HumanoidMobRenderer<AgentEntity, PlayerModel<AgentEntity>> {
    public AgentRenderer(EntityRendererProvider.Context ctx) {
        super(ctx, new PlayerModel<>(ctx.bakeLayer(ModelLayers.PLAYER), false), 0.5F);
    }

    @Override
    public ResourceLocation getTextureLocation(AgentEntity entity) {
        Component name = entity.getCustomName();
        return DefaultPlayerSkin.getDefaultSkin(skinUuid(name == null ? "" : name.getString()));
    }

    /** First name-derived UUID whose default skin uses the wide arm model (this renderer is wide). */
    static UUID skinUuid(String name) {
        for (int i = 0; ; i++) {
            UUID id = UUID.nameUUIDFromBytes((name + "#" + i).getBytes(StandardCharsets.UTF_8));
            if (!"slim".equals(DefaultPlayerSkin.getSkinModelName(id))) return id;
        }
    }
}
```

`src/main/java/com/agentopia/mc/client/ClientSetup.java`:

```java
package com.agentopia.mc.client;

import com.agentopia.mc.AgentopiaMod;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.EntityRenderersEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = AgentopiaMod.MODID, bus = Mod.EventBusSubscriber.Bus.MOD, value = Dist.CLIENT)
public final class ClientSetup {
    private ClientSetup() {}

    @SubscribeEvent
    public static void onRegisterRenderers(EntityRenderersEvent.RegisterRenderers event) {
        event.registerEntityRenderer(AgentopiaMod.AGENT.get(), AgentRenderer::new);
    }
}
```

`src/main/resources/assets/agentopia/lang/en_us.json`:

```json
{
  "entity.agentopia.agent": "Agentopia Citizen",
  "key.categories.agentopia": "Agentopia",
  "key.agentopia.camera": "Toggle spectator camera"
}
```

Temporary stub `src/main/java/com/agentopia/mc/bridge/BridgeServer.java` (replaced in Task 9):

```java
package com.agentopia.mc.bridge;

public final class BridgeServer {
    public void send(String line) {}
}
```

- [ ] **Step 2: Compile and run the unit tests**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat build`
Expected: `BUILD SUCCESSFUL`, and all earlier tests still pass. If the compiler reports that a Minecraft or Forge method does not exist in this build, look up the equivalent in the decompiled Minecraft classes (your IDE's "go to definition" on the class) and keep the behaviour described in this task.

- [ ] **Step 3: Commit**

```bash
git add minecraft/agentopia-mc/src
git commit -m "Add the NPC entity, registry and client renderer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Town generation, commands and server wiring (Java)

**Files:**
- Create: `src/main/java/com/agentopia/mc/town/TownBuilder.java`
- Create: `src/main/java/com/agentopia/mc/command/AgentopiaCommand.java`
- Create: `src/main/java/com/agentopia/mc/ServerEvents.java`
- Modify: `src/main/java/com/agentopia/mc/AgentopiaMod.java` (register `ServerEvents`)

**Interfaces:**
- Consumes: `TownLayout.plan`, `TownMap`, `TownGeometry`, `AgentRegistry.sync` and `Texts.signLines`.
- Produces:
  - `TownBuilder.generate(ServerLevel, TownMap)`
  - `AgentopiaCommand.register(CommandDispatcher<CommandSourceStack>)` with `/agentopia town generate`, `/agentopia status` and (in Task 11) `/agentopia follow`
  - `ServerEvents`: server start and stop, commands, and the tick loop that calls `AgentRegistry.tick`, plus (added in later tasks) `Bubbles.tick`, `BuildExecutor.tick` and the HUD.

- [ ] **Step 1: Write the classes**

`src/main/java/com/agentopia/mc/town/TownBuilder.java`:

```java
package com.agentopia.mc.town;

import com.agentopia.mc.util.Texts;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;

import java.util.List;

/** Builds the planned town into the world once. Runs on the server thread. */
public final class TownBuilder {
    private TownBuilder() {}

    public static void generate(ServerLevel level, TownMap town) {
        List<String> names = town.agents.stream().map(TownMap.AgentSpec::name).toList();
        town.plan = TownLayout.plan(names, town.places, 60);
        BlockPos spawn = level.getSharedSpawnPos();
        town.originX = ((spawn.getX() >> 4) + 2) << 4;
        town.originZ = ((spawn.getZ() >> 4) + 2) << 4;
        int side = town.plan.side();
        for (int cx = 0; cx < side; cx++)
            for (int cz = 0; cz < side; cz++)
                level.setChunkForced((town.originX >> 4) + cx, (town.originZ >> 4) + cz, true);
        town.originY = level.getHeight(Heightmap.Types.MOTION_BLOCKING, town.originX, town.originZ);
        int y = town.originY;
        int w = town.plan.widthBlocks();

        BlockState path = Blocks.DIRT_PATH.defaultBlockState();
        for (int x = 0; x < w; x++)
            for (int z = 0; z < w; z++)
                set(level, town, x, y - 1, z, path);

        for (TownLayout.Plot p : town.plan.plots())
            fill(level, town, p.area(), y - 1, y - 1, Blocks.GRASS_BLOCK.defaultBlockState());

        for (TownLayout.Room r : town.plan.rooms()) {
            fill(level, town, r.walls(), y - 1, y - 1, Blocks.OAK_PLANKS.defaultBlockState());
            walls(level, town, r.walls(), y, y + 2, Blocks.SPRUCE_PLANKS.defaultBlockState());
            fill(level, town, r.walls(), y + 3, y + 3, Blocks.SPRUCE_SLAB.defaultBlockState());
            set(level, town, r.doorX(), y, r.doorZ(), Blocks.AIR.defaultBlockState());
            set(level, town, r.doorX(), y + 1, r.doorZ(), Blocks.AIR.defaultBlockState());
        }

        for (TownLayout.Building b : town.plan.buildings()) {
            BlockState wall = b.kind().equals("hq") ? Blocks.POLISHED_BLACKSTONE_BRICKS.defaultBlockState() : Blocks.STONE_BRICKS.defaultBlockState();
            fill(level, town, b.footprint(), y - 1, y - 1, Blocks.OAK_PLANKS.defaultBlockState());
            walls(level, town, b.footprint(), y, y + 3, wall);
            fill(level, town, b.footprint(), y + 4, y + 4, Blocks.STONE_BRICK_SLAB.defaultBlockState());
            set(level, town, b.doorX(), y, b.doorZ(), Blocks.AIR.defaultBlockState());
            set(level, town, b.doorX(), y + 1, b.doorZ(), Blocks.AIR.defaultBlockState());
            placeSign(level, TownGeometry.abs(town, b.doorX(), b.doorZ() + 1).above(2), b.name());
        }

        GameRules rules = level.getGameRules();
        rules.getRule(GameRules.RULE_DAYLIGHT).set(false, level.getServer());
        rules.getRule(GameRules.RULE_DOMOBSPAWNING).set(false, level.getServer());
        rules.getRule(GameRules.RULE_WEATHER_CYCLE).set(false, level.getServer());
        town.generated = true;
    }

    private static void set(ServerLevel level, TownMap t, int x, int y, int z, BlockState state) {
        level.setBlock(new BlockPos(t.originX + x, y, t.originZ + z), state, 2);
    }

    private static void fill(ServerLevel level, TownMap t, Box b, int y0, int y1, BlockState state) {
        for (int y = y0; y <= y1; y++)
            for (int x = b.minX(); x <= b.maxX(); x++)
                for (int z = b.minZ(); z <= b.maxZ(); z++)
                    set(level, t, x, y, z, state);
    }

    private static void walls(ServerLevel level, TownMap t, Box b, int y0, int y1, BlockState state) {
        for (int y = y0; y <= y1; y++)
            for (int x = b.minX(); x <= b.maxX(); x++)
                for (int z = b.minZ(); z <= b.maxZ(); z++)
                    if (x == b.minX() || x == b.maxX() || z == b.minZ() || z == b.maxZ())
                        set(level, t, x, y, z, state);
    }

    /** Wall sign facing south, attached to the wall above the door. */
    private static void placeSign(ServerLevel level, BlockPos pos, String text) {
        level.setBlock(pos, Blocks.OAK_WALL_SIGN.defaultBlockState().setValue(WallSignBlock.FACING, Direction.SOUTH), 3);
        if (level.getBlockEntity(pos) instanceof SignBlockEntity sign) {
            List<String> lines = Texts.signLines(text, 15, 4);
            SignText st = sign.getFrontText();
            for (int i = 0; i < lines.size(); i++) st = st.setMessage(i, Component.literal(lines.get(i)));
            sign.setText(st, true);
            sign.setChanged();
            level.sendBlockUpdated(pos, sign.getBlockState(), sign.getBlockState(), 3);
        }
    }
}
```

`src/main/java/com/agentopia/mc/command/AgentopiaCommand.java`:

```java
package com.agentopia.mc.command;

import com.agentopia.mc.ModState;
import com.agentopia.mc.npc.AgentRegistry;
import com.agentopia.mc.town.TownBuilder;
import com.agentopia.mc.town.TownMap;
import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

public final class AgentopiaCommand {
    private AgentopiaCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("agentopia")
                .then(Commands.literal("town").then(Commands.literal("generate")
                        .requires(s -> s.hasPermission(2))
                        .executes(ctx -> generate(ctx.getSource()))))
                .then(Commands.literal("status").executes(ctx -> status(ctx.getSource()))));
    }

    private static int generate(CommandSourceStack src) {
        TownMap town = ModState.town;
        if (town.agents.isEmpty()) {
            src.sendFailure(Component.literal("No agents yet. Start the Agentopia sim with Minecraft enabled so it can send its agents and places first."));
            return 0;
        }
        if (town.generated) {
            src.sendFailure(Component.literal("The town already exists. To rebuild it, stop the server, delete the world and agentopia_town.json, and start again."));
            return 0;
        }
        TownBuilder.generate(ModState.level(), town);
        ModState.saveTown();
        AgentRegistry.sync(ModState.level(), town);
        src.sendSuccess(() -> Component.literal("Town built: " + town.plan.rooms().size() + " rooms, "
                + town.plan.buildings().size() + " buildings, " + town.plan.plots().size() + " build plots."), true);
        return 1;
    }

    private static int status(CommandSourceStack src) {
        TownMap town = ModState.town;
        boolean connected = ModState.bridge != null && ModState.bridge.connected();
        src.sendSuccess(() -> Component.literal("Sim connected: " + connected + " | town built: " + town.generated
                + " | NPCs: " + AgentRegistry.names().size() + " | builds: " + town.builds.size()
                + (ModState.hudText.isEmpty() ? "" : " | " + ModState.hudText)), false);
        return 1;
    }
}
```

The stub `BridgeServer` needs `connected()` for this to compile. Add `public boolean connected() { return false; }` to the stub (Task 9 replaces it).

`src/main/java/com/agentopia/mc/ServerEvents.java`:

```java
package com.agentopia.mc;

import com.agentopia.mc.command.AgentopiaCommand;
import com.agentopia.mc.npc.AgentRegistry;
import com.agentopia.mc.town.TownMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraftforge.event.RegisterCommandsEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;

public final class ServerEvents {
    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        ModState.server = event.getServer();
        ModState.townFile = event.getServer().getWorldPath(LevelResource.ROOT).resolve("agentopia_town.json");
        ModState.town = TownMap.load(ModState.townFile);
        if (ModState.town.generated) AgentRegistry.sync(ModState.level(), ModState.town);
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        ModState.saveTown();
    }

    @SubscribeEvent
    public void onRegisterCommands(RegisterCommandsEvent event) {
        AgentopiaCommand.register(event.getDispatcher());
    }

    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase != TickEvent.Phase.END || ModState.server == null) return;
        ServerLevel level = ModState.level();
        long now = ModState.now();
        AgentRegistry.tick(level, now);
    }
}
```

In `AgentopiaMod`'s constructor, add after the `registerConfig` line:

```java
        net.minecraftforge.common.MinecraftForge.EVENT_BUS.register(new ServerEvents());
```

- [ ] **Step 2: Compile**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat build`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add minecraft/agentopia-mc/src
git commit -m "Generate the town from the sim's places and add /agentopia commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Bridge server, command handler, chat bubbles and HUD (Java)

**Files:**
- Replace: `src/main/java/com/agentopia/mc/bridge/BridgeServer.java`
- Create: `src/main/java/com/agentopia/mc/bridge/CommandHandler.java`, `src/main/java/com/agentopia/mc/npc/Bubbles.java`
- Modify: `src/main/java/com/agentopia/mc/ServerEvents.java` (start and stop the bridge; tick bubbles and HUD)

**Interfaces:**
- Consumes: `Protocol` and `LineOutbox` (Task 5); `ModState`, `AgentRegistry` and `TownGeometry` (Task 7); `PhaseClock` (Task 5).
- Produces:
  - `BridgeServer(MinecraftServer, int port)` with `start()`, `stop()`, `connected() -> boolean` and `send(String line)` (never blocks)
  - `CommandHandler.handle(String line) -> String` (one reply line; `build` is added in Task 10)
  - `Bubbles.show(ServerLevel, AgentEntity, String text, long now)` and `Bubbles.tick(ServerLevel, long now)`

- [ ] **Step 1: Write the classes**

`src/main/java/com/agentopia/mc/bridge/BridgeServer.java`:

```java
package com.agentopia.mc.bridge;

import com.agentopia.mc.protocol.LineOutbox;
import com.mojang.logging.LogUtils;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Localhost-only listener for the Python sim. One client at a time.
 * Requests run on the server thread; replies and events go through a bounded
 * outbox drained by a writer thread, so a slow or paused sim never blocks the game.
 */
public final class BridgeServer {
    private static final Logger LOGGER = LogUtils.getLogger();

    private final MinecraftServer server;
    private final int port;
    private final LineOutbox outbox = new LineOutbox(2000);
    private volatile boolean running;
    private volatile ServerSocket serverSocket;
    private volatile Socket client;
    private volatile BufferedWriter writer;

    public BridgeServer(MinecraftServer server, int port) {
        this.server = server;
        this.port = port;
    }

    public void start() {
        try {
            serverSocket = new ServerSocket(port, 1, InetAddress.getLoopbackAddress());
        } catch (IOException e) {
            LOGGER.error("Agentopia bridge could not listen on 127.0.0.1:{}", port, e);
            return;
        }
        running = true;
        daemon(this::acceptLoop, "agentopia-bridge-accept");
        daemon(this::writeLoop, "agentopia-bridge-write");
        LOGGER.info("Agentopia bridge listening on 127.0.0.1:{}", port);
    }

    public void stop() {
        running = false;
        closeQuietly(client);
        closeQuietly(serverSocket);
    }

    public boolean connected() {
        Socket c = client;
        return c != null && !c.isClosed();
    }

    /** Queues a line for the sim. Never blocks; dropped when nobody is connected or the queue is full. */
    public void send(String line) {
        if (connected()) outbox.offer(line);
    }

    private void acceptLoop() {
        while (running) {
            try (Socket s = serverSocket.accept()) {
                s.setTcpNoDelay(true);
                outbox.clear();
                writer = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                client = s;
                LOGGER.info("Agentopia sim connected");
                BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while (running && (line = in.readLine()) != null) {
                    if (line.isBlank()) continue;
                    final String request = line;
                    server.execute(() -> send(CommandHandler.handle(request)));
                }
            } catch (IOException e) {
                if (running) LOGGER.info("Agentopia sim disconnected: {}", e.getMessage());
            } finally {
                client = null;
                writer = null;
            }
        }
    }

    private void writeLoop() {
        while (running) {
            try {
                String line = outbox.take();
                BufferedWriter w = writer;
                if (w == null) continue;
                w.write(line);
                w.write('\n');
                w.flush();
            } catch (InterruptedException e) {
                return;
            } catch (IOException e) {
                closeQuietly(client);
            }
        }
    }

    private static void daemon(Runnable r, String name) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
        }
    }
}
```

`src/main/java/com/agentopia/mc/npc/Bubbles.java`:

```java
package com.agentopia.mc.npc;

import com.agentopia.mc.util.Texts;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;

/** Short-lived text displays floating above talking NPCs. */
public final class Bubbles {
    private record Bubble(UUID display, String agent, long expires) {}

    private static final List<Bubble> ACTIVE = new ArrayList<>();
    private static final long LIFETIME = 160; // 8 s

    private Bubbles() {}

    public static void show(ServerLevel level, AgentEntity npc, String text, long now) {
        Iterator<Bubble> it = ACTIVE.iterator();
        while (it.hasNext()) {
            Bubble b = it.next();
            if (b.agent().equals(npc.getAgentName())) {
                discard(level, b);
                it.remove();
            }
        }
        Display.TextDisplay d = EntityType.TEXT_DISPLAY.create(level);
        if (d == null) return;
        CompoundTag tag = new CompoundTag();
        tag.putString("text", Component.Serializer.toJson(Component.literal(Texts.shorten(text, 120))));
        tag.putString("billboard", "center");
        tag.putInt("line_width", 160);
        tag.putInt("background", 0x99000000);
        d.load(tag);
        d.setPos(npc.getX(), npc.getY() + 2.4D, npc.getZ());
        level.addFreshEntity(d);
        ACTIVE.add(new Bubble(d.getUUID(), npc.getAgentName(), now + LIFETIME));
    }

    public static void tick(ServerLevel level, long now) {
        Iterator<Bubble> it = ACTIVE.iterator();
        while (it.hasNext()) {
            Bubble b = it.next();
            Entity display = level.getEntity(b.display());
            if (display == null || now >= b.expires()) {
                discard(level, b);
                it.remove();
                continue;
            }
            AgentRegistry.get(level, b.agent()).ifPresent(npc -> display.setPos(npc.getX(), npc.getY() + 2.4D, npc.getZ()));
        }
    }

    private static void discard(ServerLevel level, Bubble b) {
        Entity e = level.getEntity(b.display());
        if (e != null) e.discard();
    }
}
```

`src/main/java/com/agentopia/mc/bridge/CommandHandler.java`:

```java
package com.agentopia.mc.bridge;

import com.agentopia.mc.ModState;
import com.agentopia.mc.build.Blueprints;
import com.agentopia.mc.npc.AgentEntity;
import com.agentopia.mc.npc.AgentRegistry;
import com.agentopia.mc.npc.Bubbles;
import com.agentopia.mc.protocol.Protocol;
import com.agentopia.mc.protocol.ProtocolException;
import com.agentopia.mc.time.PhaseClock;
import com.agentopia.mc.town.Box;
import com.agentopia.mc.town.TownGeometry;
import com.agentopia.mc.town.TownLayout;
import com.agentopia.mc.town.TownMap;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import org.slf4j.Logger;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/** Executes one bridge request on the server thread and returns the reply line. */
public final class CommandHandler {
    private static final Logger LOGGER = LogUtils.getLogger();

    private CommandHandler() {}

    public static String handle(String line) {
        Protocol.Request req;
        try {
            req = Protocol.parse(line);
        } catch (ProtocolException e) {
            LOGGER.warn("Agentopia bridge: ignoring bad request ({}): {}", e.getMessage(), line);
            return Protocol.error(-1, "bad_request");
        }
        try {
            return dispatch(req);
        } catch (RuntimeException e) {
            LOGGER.warn("Agentopia bridge: {} failed", req.cmd(), e);
            return Protocol.error(req.id(), "bad_request");
        }
    }

    private static String dispatch(Protocol.Request req) {
        ServerLevel level = ModState.level();
        TownMap town = ModState.town;
        long now = ModState.now();
        switch (req.cmd()) {
            case "hello": {
                JsonObject o = new JsonObject();
                o.addProperty("version", Protocol.VERSION);
                JsonArray bps = new JsonArray();
                Blueprints.ALL.keySet().stream().sorted().forEach(bps::add);
                o.add("blueprints", bps);
                return Protocol.ok(req.id(), o);
            }
            case "sync_agents": {
                List<TownMap.AgentSpec> agents = new ArrayList<>();
                for (JsonElement e : req.body().getAsJsonArray("agents")) {
                    JsonObject a = e.getAsJsonObject();
                    agents.add(new TownMap.AgentSpec(a.get("name").getAsString(), a.has("faction") ? a.get("faction").getAsString() : ""));
                }
                List<TownLayout.PlaceSpec> places = new ArrayList<>();
                for (JsonElement e : req.body().getAsJsonArray("places")) {
                    JsonObject p = e.getAsJsonObject();
                    places.add(new TownLayout.PlaceSpec(p.get("name").getAsString(), p.has("size") ? p.get("size").getAsString() : "small"));
                }
                town.agents = agents;
                if (!town.generated) town.places = places; // the built town keeps its buildings
                ModState.saveTown();
                if (town.generated) AgentRegistry.sync(level, town);
                JsonObject o = new JsonObject();
                o.addProperty("town_ready", town.generated);
                return Protocol.ok(req.id(), o);
            }
            case "set_phase": {
                String stage = req.str("stage");
                int slot = req.integer("slot", 0);
                level.setDayTime(PhaseClock.dayTime(stage, slot));
                ModState.hudText = PhaseClock.hudText(req.integer("year", 0), req.integer("week", 0), stage, req.integer("day", 0), slot);
                if (req.bool("send_home") && town.generated) {
                    for (String n : AgentRegistry.names())
                        AgentRegistry.moveTo(level, n, TownGeometry.homePos(town, n), TownGeometry.homeBox(town, n), now);
                }
                return Protocol.ok(req.id(), null);
            }
            case "move":
                return move(req, level, town, now);
            case "say": {
                Optional<AgentEntity> npc = AgentRegistry.get(level, req.str("agent"));
                if (npc.isEmpty()) return Protocol.error(req.id(), "unknown_agent");
                String text = req.str("text");
                Bubbles.show(level, npc.get(), text, now);
                String to = req.str("to");
                Component line = Component.literal("[" + req.str("agent") + (to == null ? "" : " → " + to) + "] " + text)
                        .withStyle(ChatFormatting.GRAY);
                level.getServer().getPlayerList().broadcastSystemMessage(line, false);
                return Protocol.ok(req.id(), null);
            }
            default:
                return Protocol.error(req.id(), "bad_request");
        }
    }

    private static String move(Protocol.Request req, ServerLevel level, TownMap town, long now) {
        if (!town.generated) return Protocol.error(req.id(), "town_not_ready");
        String agent = req.str("agent");
        if (AgentRegistry.get(level, agent).isEmpty()) return Protocol.error(req.id(), "unknown_agent");
        String place = req.str("place");
        String targetAgent = req.str("target_agent");
        BlockPos target;
        Box wander;
        if ("home".equalsIgnoreCase(place)) {
            target = TownGeometry.homePos(town, agent);
            wander = TownGeometry.homeBox(town, agent);
        } else if (place != null) {
            Optional<TownLayout.Building> b = town.building(place);
            if (b.isEmpty()) return Protocol.error(req.id(), "unknown_place");
            target = TownGeometry.placePos(town, b.get());
            wander = TownGeometry.placeBox(town, b.get());
        } else if (targetAgent != null) {
            Optional<AgentEntity> other = AgentRegistry.get(level, targetAgent);
            if (other.isEmpty()) return Protocol.error(req.id(), "unknown_agent");
            BlockPos p = other.get().blockPosition();
            target = p.offset(1, 0, 0);
            wander = new Box(p.getX() - 2, p.getZ() - 2, p.getX() + 2, p.getZ() + 2);
        } else {
            return Protocol.error(req.id(), "bad_request");
        }
        AgentRegistry.moveTo(level, agent, target, wander, now);
        return Protocol.ok(req.id(), null);
    }
}
```

- [ ] **Step 2: Start the bridge and tick bubbles and the HUD**

In `ServerEvents`:
- At the end of `onServerStarted`, add:

```java
        ModState.bridge = new com.agentopia.mc.bridge.BridgeServer(event.getServer(), Config.BRIDGE_PORT.get());
        ModState.bridge.start();
```

- At the start of `onServerStopping`, add:

```java
        if (ModState.bridge != null) ModState.bridge.stop();
```

- At the end of `onServerTick`, add:

```java
        com.agentopia.mc.npc.Bubbles.tick(level, now);
        if (now % 40 == 0 && !ModState.hudText.isEmpty()) {
            net.minecraft.network.chat.Component hud = net.minecraft.network.chat.Component.literal(ModState.hudText);
            for (net.minecraft.server.level.ServerPlayer p : ModState.server.getPlayerList().getPlayers())
                if (p.isSpectator() && p.hasPermissions(2)) p.displayClientMessage(hud, true);
        }
```

- [ ] **Step 3: Compile**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat build`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

```bash
git add minecraft/agentopia-mc/src
git commit -m "Add the localhost bridge, command handling, chat bubbles and HUD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Building in the world (Java)

**Files:**
- Create: `src/main/java/com/agentopia/mc/build/BuildExecutor.java`
- Modify: `src/main/java/com/agentopia/mc/bridge/CommandHandler.java` (add the `build` case)
- Modify: `src/main/java/com/agentopia/mc/ServerEvents.java` (reset on start; tick)
- Modify: `src/main/java/com/agentopia/mc/command/AgentopiaCommand.java` (reset after generating)

**Interfaces:**
- Consumes: `Blueprints`, `PlotAllocator`, `TownMap`, `TownGeometry` and `AgentRegistry`.
- Produces:
  - `BuildExecutor.reset(TownMap)`
  - `BuildExecutor.start(ServerLevel, TownMap, String agent, String blueprint, String near, long now) -> JsonObject {job, plot?}` (throws `BuildExecutor.Rejected(reason)`)
  - `BuildExecutor.tick(ServerLevel, TownMap, long now)`
  - Events emitted:
    - `build_progress {job, agent, pct}`
    - `build_done {job, agent, blueprint, place, plot?}`
    - `build_failed {job, agent, reason}`

- [ ] **Step 1: Write the executor**

`src/main/java/com/agentopia/mc/build/BuildExecutor.java`:

```java
package com.agentopia.mc.build;

import com.agentopia.mc.ModState;
import com.agentopia.mc.npc.AgentEntity;
import com.agentopia.mc.npc.AgentRegistry;
import com.agentopia.mc.town.PlotAllocator;
import com.agentopia.mc.town.TownGeometry;
import com.agentopia.mc.town.TownLayout;
import com.agentopia.mc.town.TownMap;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraftforge.registries.ForgeRegistries;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Places blueprint blocks over time while the NPC "works". Server thread only. */
public final class BuildExecutor {
    public static final class Rejected extends Exception {
        public Rejected(String reason) {
            super(reason);
        }
    }

    private static final class Job {
        String id, agent, place;
        Blueprint bp;
        BlockPos origin, stand;
        Integer plotId;
        int next;
        int lastPct;
        boolean placing;
        long arriveBy, nextTick;
    }

    private static final Map<String, Job> BY_AGENT = new HashMap<>();
    private static final long TICKS_PER_BLOCK = 10; // 2 blocks per second
    private static int counter;
    private static PlotAllocator allocator;

    private BuildExecutor() {}

    /** Call after loading or generating the town. Plots claimed by unfinished jobs are freed. */
    public static void reset(TownMap town) {
        BY_AGENT.clear();
        if (town.plan == null) {
            allocator = null;
            return;
        }
        Set<Integer> built = town.builtPlots();
        town.plotOwners.keySet().removeIf(id -> !built.contains(id));
        allocator = new PlotAllocator(town.plan.plots(), new HashSet<>(town.plotOwners.keySet()));
    }

    public static JsonObject start(ServerLevel level, TownMap town, String agent, String blueprintId, String near, long now) throws Rejected {
        if (!town.generated || allocator == null) throw new Rejected("town_not_ready");
        Blueprint bp = Blueprints.ALL.get(blueprintId);
        if (bp == null) throw new Rejected("unknown_blueprint");
        if (AgentRegistry.get(level, agent).isEmpty()) throw new Rejected("unknown_agent");
        if (BY_AGENT.containsKey(agent)) throw new Rejected("busy");

        Job j = new Job();
        j.id = "b" + (++counter);
        j.agent = agent;
        j.bp = bp;
        int refX, refZ;
        if (near == null || near.equalsIgnoreCase("home")) {
            TownLayout.Room room = town.room(agent).orElseThrow(() -> new Rejected("unknown_agent"));
            refX = room.doorX();
            refZ = room.doorZ();
            j.place = "home";
            if (!bp.usesPlot()) {
                j.origin = TownGeometry.abs(town, room.interior().minX(), room.interior().minZ());
                j.stand = TownGeometry.abs(town, room.standX(), room.standZ());
            }
        } else {
            if (!bp.usesPlot()) throw new Rejected("bad_request");
            TownLayout.Building b = town.building(near).orElseThrow(() -> new Rejected("unknown_place"));
            refX = b.doorX();
            refZ = b.doorZ();
            j.place = b.name();
        }
        if (bp.usesPlot()) {
            TownLayout.Plot plot = allocator.reserveNearest(refX, refZ).orElseThrow(() -> new Rejected("no_free_plot"));
            j.plotId = plot.id();
            town.plotOwners.put(plot.id(), agent);
            j.origin = TownGeometry.abs(town, plot.area().minX(), plot.area().minZ());
            j.stand = TownGeometry.abs(town, plot.standX(), plot.standZ());
        }
        j.arriveBy = now + 600; // start placing after 30 s even if the walk is slow
        AgentRegistry.moveTo(level, agent, j.stand, null, now);
        BY_AGENT.put(agent, j);
        JsonObject reply = new JsonObject();
        reply.addProperty("job", j.id);
        if (j.plotId != null) reply.addProperty("plot", j.plotId);
        return reply;
    }

    public static void tick(ServerLevel level, TownMap town, long now) {
        Iterator<Job> it = BY_AGENT.values().iterator();
        while (it.hasNext()) {
            Job j = it.next();
            Optional<AgentEntity> npc = AgentRegistry.get(level, j.agent);
            if (npc.isEmpty()) {
                fail(town, j, "unknown_agent");
                it.remove();
                continue;
            }
            if (!j.placing) {
                if (npc.get().isMoving() && now < j.arriveBy) continue;
                j.placing = true;
                j.nextTick = now;
            }
            if (now < j.nextTick) continue;
            j.nextTick = now + TICKS_PER_BLOCK;
            Blueprint.Placement p = j.bp.placements().get(j.next++);
            BlockPos pos = j.origin.offset(p.dx(), p.dy(), p.dz());
            level.setBlock(pos, state(p.block()), 3);
            npc.get().swing(InteractionHand.MAIN_HAND);
            npc.get().getLookControl().setLookAt(pos.getX() + 0.5D, pos.getY() + 0.5D, pos.getZ() + 0.5D);
            int pct = 100 * j.next / j.bp.placements().size();
            if (pct >= j.lastPct + 25 && pct < 100) {
                j.lastPct = pct - pct % 25;
                JsonObject f = new JsonObject();
                f.addProperty("job", j.id);
                f.addProperty("agent", j.agent);
                f.addProperty("pct", j.lastPct);
                ModState.emit("build_progress", f);
            }
            if (j.next >= j.bp.placements().size()) {
                town.builds.add(new TownMap.BuildRecord(j.agent, j.bp.id(), j.place, j.plotId, j.origin.getX(), j.origin.getY(), j.origin.getZ()));
                ModState.saveTown();
                JsonObject f = new JsonObject();
                f.addProperty("job", j.id);
                f.addProperty("agent", j.agent);
                f.addProperty("blueprint", j.bp.id());
                f.addProperty("place", j.place);
                if (j.plotId != null) f.addProperty("plot", j.plotId);
                ModState.emit("build_done", f);
                it.remove();
            }
        }
    }

    private static void fail(TownMap town, Job j, String reason) {
        if (j.plotId != null) {
            town.plotOwners.remove(j.plotId);
            if (allocator != null) allocator.release(j.plotId);
        }
        JsonObject f = new JsonObject();
        f.addProperty("job", j.id);
        f.addProperty("agent", j.agent);
        f.addProperty("reason", reason);
        ModState.emit("build_failed", f);
    }

    private static BlockState state(String id) {
        Block b = ForgeRegistries.BLOCKS.getValue(new ResourceLocation(id));
        return b == null ? Blocks.AIR.defaultBlockState() : b.defaultBlockState();
    }
}
```

- [ ] **Step 2: Wire it up**

In `CommandHandler.dispatch`, add this case before `default:`:

```java
            case "build": {
                try {
                    return Protocol.ok(req.id(), com.agentopia.mc.build.BuildExecutor.start(
                            level, town, req.str("agent"), req.str("blueprint"), req.str("near"), now));
                } catch (com.agentopia.mc.build.BuildExecutor.Rejected r) {
                    return Protocol.error(req.id(), r.getMessage());
                }
            }
```

In `ServerEvents.onServerStarted`, after `ModState.town = TownMap.load(...)`, add `com.agentopia.mc.build.BuildExecutor.reset(ModState.town);`. In `onServerTick`, after `AgentRegistry.tick(level, now);`, add `com.agentopia.mc.build.BuildExecutor.tick(level, ModState.town, now);`.

In `AgentopiaCommand.generate`, after `ModState.saveTown();`, add `com.agentopia.mc.build.BuildExecutor.reset(town);`.

- [ ] **Step 3: Compile**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat build`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

```bash
git add minecraft/agentopia-mc/src
git commit -m "Let NPCs build blueprints on plots and in their rooms" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Spectator camera toggle and follow (Java)

**Files:**
- Create: `src/main/java/com/agentopia/mc/camera/CameraToggle.java`
- Create: `src/main/java/com/agentopia/mc/net/Net.java`, `ToggleCameraPacket.java`
- Create: `src/main/java/com/agentopia/mc/client/Keys.java`, `ClientEvents.java`
- Modify: `src/main/java/com/agentopia/mc/client/ClientSetup.java` (register the key)
- Modify: `src/main/java/com/agentopia/mc/AgentopiaMod.java` (register the network channel)
- Modify: `src/main/java/com/agentopia/mc/command/AgentopiaCommand.java` (add `follow`)

**Interfaces:**
- Produces:
  - `CameraToggle.toggle(ServerPlayer)` and `CameraToggle.enterSpectator(ServerPlayer)`
  - `Net.CHANNEL` and `Net.register()`
  - `ToggleCameraPacket`
  - `Keys.TOGGLE_CAMERA`
  - `/agentopia follow <name>`

- [ ] **Step 1: Write the classes**

`src/main/java/com/agentopia/mc/camera/CameraToggle.java`:

```java
package com.agentopia.mc.camera;

import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Switches an operator between their normal character and a free spectator camera. */
public final class CameraToggle {
    private record Saved(GameType mode, ResourceKey<Level> dim, double x, double y, double z, float yRot, float xRot) {}

    private static final Map<UUID, Saved> SAVED = new HashMap<>();

    private CameraToggle() {}

    public static void toggle(ServerPlayer p) {
        if (!p.hasPermissions(2)) {
            p.displayClientMessage(Component.literal("Only operators can use the Agentopia camera."), true);
            return;
        }
        if (p.isSpectator()) exitSpectator(p);
        else enterSpectator(p);
    }

    public static void enterSpectator(ServerPlayer p) {
        if (!p.isSpectator()) {
            SAVED.put(p.getUUID(), new Saved(p.gameMode.getGameModeForPlayer(), p.level().dimension(),
                    p.getX(), p.getY(), p.getZ(), p.getYRot(), p.getXRot()));
            p.setGameMode(GameType.SPECTATOR);
        }
        p.displayClientMessage(Component.literal("Spectator camera on - press the camera key again to go back."), true);
    }

    private static void exitSpectator(ServerPlayer p) {
        p.setCamera(p);
        Saved s = SAVED.remove(p.getUUID());
        if (s == null) {
            p.setGameMode(p.server.getDefaultGameType());
            return;
        }
        ServerLevel level = p.server.getLevel(s.dim());
        if (level != null) p.teleportTo(level, s.x(), s.y(), s.z(), s.yRot(), s.xRot());
        p.setGameMode(s.mode());
    }
}
```

`src/main/java/com/agentopia/mc/net/ToggleCameraPacket.java`:

```java
package com.agentopia.mc.net;

import com.agentopia.mc.camera.CameraToggle;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

public final class ToggleCameraPacket {
    public static void encode(ToggleCameraPacket msg, FriendlyByteBuf buf) {}

    public static ToggleCameraPacket decode(FriendlyByteBuf buf) {
        return new ToggleCameraPacket();
    }

    public static void handle(ToggleCameraPacket msg, Supplier<NetworkEvent.Context> ctx) {
        ServerPlayer p = ctx.get().getSender();
        if (p != null) CameraToggle.toggle(p);
    }
}
```

`src/main/java/com/agentopia/mc/net/Net.java`:

```java
package com.agentopia.mc.net;

import com.agentopia.mc.AgentopiaMod;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.network.NetworkDirection;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.simple.SimpleChannel;

public final class Net {
    private static final String PROTOCOL = "1";
    // acceptMissingOr lets a client with this mod still join servers that do not have it.
    public static final SimpleChannel CHANNEL = NetworkRegistry.newSimpleChannel(
            new ResourceLocation(AgentopiaMod.MODID, "main"), () -> PROTOCOL,
            NetworkRegistry.acceptMissingOr(PROTOCOL), NetworkRegistry.acceptMissingOr(PROTOCOL));

    private Net() {}

    public static void register() {
        CHANNEL.messageBuilder(ToggleCameraPacket.class, 0, NetworkDirection.PLAY_TO_SERVER)
                .encoder(ToggleCameraPacket::encode)
                .decoder(ToggleCameraPacket::decode)
                .consumerMainThread(ToggleCameraPacket::handle)
                .add();
    }
}
```

`src/main/java/com/agentopia/mc/client/Keys.java`:

```java
package com.agentopia.mc.client;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;

public final class Keys {
    public static final KeyMapping TOGGLE_CAMERA = new KeyMapping("key.agentopia.camera", InputConstants.KEY_V, "key.categories.agentopia");

    private Keys() {}
}
```

`src/main/java/com/agentopia/mc/client/ClientEvents.java`:

```java
package com.agentopia.mc.client;

import com.agentopia.mc.AgentopiaMod;
import com.agentopia.mc.net.Net;
import com.agentopia.mc.net.ToggleCameraPacket;
import net.minecraft.client.Minecraft;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = AgentopiaMod.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
public final class ClientEvents {
    private ClientEvents() {}

    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        Minecraft mc = Minecraft.getInstance();
        while (Keys.TOGGLE_CAMERA.consumeClick()) {
            if (mc.getConnection() != null && Net.CHANNEL.isRemotePresent(mc.getConnection().getConnection()))
                Net.CHANNEL.sendToServer(new ToggleCameraPacket());
        }
    }
}
```

In `ClientSetup`, add:

```java
    @SubscribeEvent
    public static void onRegisterKeys(net.minecraftforge.client.event.RegisterKeyMappingsEvent event) {
        event.register(Keys.TOGGLE_CAMERA);
    }
```

In `AgentopiaMod`'s constructor, add `com.agentopia.mc.net.Net.register();`.

In `AgentopiaCommand.register`, add this branch to the `agentopia` literal (alongside `town` and `status`):

```java
                .then(Commands.literal("follow").requires(s -> s.hasPermission(2))
                        .then(Commands.argument("name", com.mojang.brigadier.arguments.StringArgumentType.greedyString())
                                .executes(ctx -> follow(ctx.getSource(),
                                        com.mojang.brigadier.arguments.StringArgumentType.getString(ctx, "name")))))
```

and the method:

```java
    private static int follow(CommandSourceStack src, String name) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
        net.minecraft.server.level.ServerPlayer p = src.getPlayerOrException();
        java.util.Optional<com.agentopia.mc.npc.AgentEntity> npc = AgentRegistry.get(ModState.level(), name.strip());
        if (npc.isEmpty()) {
            src.sendFailure(Component.literal("No agent called \"" + name.strip() + "\"."));
            return 0;
        }
        com.agentopia.mc.camera.CameraToggle.enterSpectator(p);
        p.setCamera(npc.get());
        return 1;
    }
```

- [ ] **Step 2: Compile**

Run (PowerShell, `minecraft\agentopia-mc`): `.\gradlew-low.bat build`
Expected: `BUILD SUCCESSFUL`, and `build\libs\agentopia-1.0.0.jar` exists.

- [ ] **Step 3: Commit**

```bash
git add minecraft/agentopia-mc/src
git commit -m "Add the spectator camera toggle key and /agentopia follow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The agent world server

**Files:**
- Create: `minecraft/server/server.properties`, `minecraft/server/user_jvm_args.txt`, `START-MC-SERVER.bat`

**Interfaces:**
- Produces: a Forge 1.20.1 server on port 25566 that loads `agentopia-1.0.0.jar`, started with `START-MC-SERVER.bat`.

- [ ] **Step 1: Install the Forge server**

Run (PowerShell, repo root):

```powershell
New-Item -ItemType Directory -Force minecraft\server | Out-Null
Invoke-WebRequest https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar -OutFile minecraft\server\forge-installer.jar
Push-Location minecraft\server
java -jar forge-installer.jar --installServer | Select-Object -Last 3
Pop-Location
```

Expected: the last lines report a successful install, and `minecraft\server\run.bat` exists.

- [ ] **Step 2: Configure it**

Overwrite `minecraft/server/user_jvm_args.txt` with:

```
-Xms1G
-Xmx2G
```

Create `minecraft/server/server.properties`:

```properties
server-port=25566
motd=Agentopia agent world
level-name=agentopia
level-type=minecraft\:flat
generate-structures=false
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
view-distance=6
simulation-distance=4
spawn-protection=0
max-players=4
online-mode=true
difficulty=peaceful
```

- [ ] **Step 3: Ask the owner to accept the Minecraft EULA**

Tell the owner: "Running a Minecraft server requires accepting Mojang's EULA (https://aka.ms/MinecraftEULA). Do you accept it?" Only after they say yes, write `minecraft/server/eula.txt` with the single line `eula=true`.

- [ ] **Step 4: Create the launcher**

`START-MC-SERVER.bat` in the repo root (CRLF line endings):

```bat
@echo off
rem Starts the Agentopia agent world (Forge 1.20.1, port 25566) at below-normal priority.
setlocal
cd /d "%~dp0minecraft\server"
title Agentopia Minecraft server
if not exist "run.bat" (
    echo The agent server is not installed yet - see WINDOWS-SETUP.md.
    pause
    goto :eof
)
if not exist "mods" mkdir mods
copy /y "%~dp0minecraft\agentopia-mc\build\libs\agentopia-1.0.0.jar" mods\ >nul 2>nul
start "" /b /wait /belownormal cmd /c run.bat nogui
pause
```

- [ ] **Step 5: First start**

Run (PowerShell): `Start-Process -FilePath C:\Projects\Agentopia\START-MC-SERVER.bat -WorkingDirectory C:\Projects\Agentopia`
Wait until `minecraft\server\logs\latest.log` contains `Done (`. Then confirm `Agentopia bridge listening on 127.0.0.1:8770` is in the same log.
Expected: both lines present, no `Exception` from `com.agentopia`.

- [ ] **Step 6: Commit**

```bash
git add minecraft/server/server.properties minecraft/server/user_jvm_args.txt START-MC-SERVER.bat
git commit -m "Add the Agentopia agent world server and launcher" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Smoke test, end-to-end run and setup docs

**Files:**
- Create: `scripts/mc_smoke.py`
- Modify: `WINDOWS-SETUP.md` (add an "Agentopia in Minecraft" section)

**Interfaces:**
- Consumes: `MinecraftBridge` (Task 2) and the running agent server (Task 12).

- [ ] **Step 1: Write the smoke-test driver**

`scripts/mc_smoke.py`:

```python
"""Drives the agentopia-mc mod by hand: sync three agents, then move, talk and build.

Usage (repo root, agent server running):
    .venv/Scripts/python.exe scripts/mc_smoke.py sync
    (in Minecraft as an operator: /agentopia town generate)
    .venv/Scripts/python.exe scripts/mc_smoke.py act
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.minecraft.bridge import MinecraftBridge  # noqa: E402

AGENTS = [{"name": "Amara Okafor", "faction": ""}, {"name": "Étienne Bellamy", "faction": "thai_guardians"},
          {"name": "TGOT", "faction": "thai_guardians"}]
PLACES = [{"name": "Corner Coffee Shop", "size": "medium"}, {"name": "The Rooftop", "size": "large"},
          {"name": "ThAI Guardians HQ", "size": "hq"}]


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "sync"
    bridge = MinecraftBridge()
    print("hello:", bridge.connect())
    print("sync:", bridge.request("sync_agents", agents=AGENTS, places=PLACES))
    if mode != "act":
        print("Now run /agentopia town generate in Minecraft, then: scripts/mc_smoke.py act")
        return
    print("phase:", bridge.request("set_phase", year=2020, week=1, stage="contact", day=0, slot=2, send_home=False))
    print("move:", bridge.request("move", agent="Amara Okafor", place="Corner Coffee Shop"))
    print("move:", bridge.request("move", agent="Étienne Bellamy", target_agent="Amara Okafor"))
    print("say:", bridge.request("say", agent="Étienne Bellamy", to="Amara Okafor", text="Bonjour! Coffee on the rooftop later?"))
    reply = bridge.request("build", agent="TGOT", blueprint="garden", near="ThAI Guardians HQ")
    print("build:", reply)
    if reply.get("ok"):
        evt = bridge.wait_event(lambda e: e.get("job") == reply["job"] and e["event"] in ("build_done", "build_failed"), 240)
        print("build result:", evt)
    print("bad place:", bridge.request("move", agent="TGOT", place="Nowhere"))
    bridge.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the smoke test in game**

1. With the agent server running, run `.venv/Scripts/python.exe scripts/mc_smoke.py sync`. Expected: `hello` reply with 6 blueprints, then `sync` with `town_ready: false`.
2. Ask the owner to install the jar on their client: copy `minecraft\agentopia-mc\build\libs\agentopia-1.0.0.jar` into the `mods` folder of their Forge 1.20.1 client. Ask them which launcher and profile they use if the folder is unclear.
3. Have the owner join `localhost:25566`, make themselves operator from the server console (`op <their name>`), and run `/agentopia town generate`. Expected: "Town built: 3 rooms, 3 buildings, 60 build plots." and three named NPCs in their rooms.
4. Run `.venv/Scripts/python.exe scripts/mc_smoke.py act`. Expected:
   - Amara walks to the Corner Coffee Shop.
   - Étienne walks to Amara and a bubble shows "Bonjour! ...". The chat shows `[Étienne Bellamy → Amara Okafor] ...`.
   - TGOT walks to a plot near the HQ and builds a garden. The script prints `build_done`.
   - `bad place` prints `error: unknown_place`.
5. Have the owner press **V**. Expected: spectator mode with the HUD "Year 2020 · Week 1 · Talk round 2". Pressing V again returns them to where they were. Then `/agentopia follow Étienne Bellamy` attaches the camera.
6. Check `minecraft\server\logs\latest.log` for `com.agentopia` exceptions. Expected: none.

- [ ] **Step 3: End-to-end with the real sim (ask first)**

Ask the owner: "The end-to-end test runs the real sim with Minecraft on, using the GPU for about 20–30 minutes. OK now?" After a yes:
1. Pause the 102-agent run with `PAUSE-SIM.bat`.
2. Set `"minecraft": {"enabled": true, ...}` in `config.json`.
3. Start a separate short run: `.venv\Scripts\python.exe scripts\run_world.py --world apartment --max-agents 10 --years 1 --weeks 1`.
4. Once the log shows `PLAN STAGE`, the mod has received the sync; run `/agentopia town generate` in the new world. Use a fresh world folder if the smoke-test town exists.
5. Watch one week. Expected:
   - NPCs go home at plan time.
   - Bubbles appear during the talk rounds.
   - NPCs walk to places on activity days.
   - The sim log has no Minecraft tracebacks.
   - If any agent chose `build(...)`, the structure appears and its place's `objects` in `data\<run>\locations.json` gain "... built by ...".
6. Stop the short run, set `enabled` back as the owner wants it, and resume the 102-agent run with `RESUME-SIM.bat`.

- [ ] **Step 4: Document the setup**

Append to `WINDOWS-SETUP.md`:

````markdown
## Agentopia in Minecraft

The sim can act itself out in a Minecraft world: every agent is an NPC that walks, talks and builds.

1. **Build the mod** (once, and after mod changes): in `minecraft\agentopia-mc`, run `gradlew-low.bat build`. This produces `build\libs\agentopia-1.0.0.jar`.
2. **Your client:** copy that jar into the `mods` folder of your Forge 1.20.1 client. It does not affect other servers.
3. **The agent server:** double-click `START-MC-SERVER.bat`. It runs on port 25566, separate from your other server, with 2 GB of RAM at low priority.
4. **Turn it on in the sim:** set `"minecraft": {"enabled": true}` in `config.json` (see `config.example.json` for all keys). For a run that already exists, edit that run's `data\<run>\config.json` instead.
5. **First time only:** once the sim has started, join `localhost:25566` as an operator and run `/agentopia town generate`.
6. **Watching:**
   - Press **V** to switch between your character and the free spectator camera.
   - `/agentopia follow <name>` rides along with an agent.
   - `/agentopia status` shows whether the sim is connected.

If Minecraft is not running, the sim carries on exactly as before.
````

- [ ] **Step 5: Commit**

```bash
git add scripts/mc_smoke.py WINDOWS-SETUP.md
git commit -m "Add Minecraft smoke-test driver and setup docs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

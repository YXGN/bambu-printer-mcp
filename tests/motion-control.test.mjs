/**
 * Offline unit & MCP contract tests for heatbed Z-axis motion (move_bed_z)
 * and toolhead / nozzle control (control_toolhead).
 *
 * Strictly zero real-printer network traffic: all printer interactions use
 * in-memory mocked BambuImplementation transports and the no-network preload.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { trackedMkdtemp } from "./support/temp.mjs";
import { BambuImplementation } from "../dist/printers/bambu.js";
import {
  buildBedZMotionGcode,
  buildToolheadControlGcode,
  extractObservedNozzleTempC,
} from "../dist/safety/motion.js";

const host = "127.0.0.1";
const serial = "22E8TESTP2S0001";
const token = "TEST_TOKEN";
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const noNetworkPreload = fileURLToPath(new URL("./fixtures/inspection-no-network.mjs", import.meta.url));

function mockSafetyStatus({
  model = "p2s",
  state = "IDLE",
  printError = 0,
  hms = [],
  nozzleTemper = 28,
  ageMs = 10,
  ...rawExtra
} = {}) {
  const now = Date.now();
  return {
    connected: true,
    model,
    status: state,
    serial,
    raw: {
      model,
      gcode_state: state,
      print_error: printError,
      hms,
      nozzle_temper: nozzleTemper,
      ...rawExtra,
    },
    observation: {
      source: "mqtt",
      requestedAt: now - ageMs - 5,
      receivedAt: now - ageMs,
      identitySource: "report",
    },
  };
}

function mockPrinter(status = mockSafetyStatus()) {
  const printer = new BambuImplementation(async () => true);
  const events = [];
  printer.getSafetyStatus = async () => {
    events.push({ action: "status" });
    return status;
  };
  printer.getPrinter = async () => {
    events.push({ action: "connect" });
    return {
      publish: async (payload) => {
        events.push({ action: "publish", payload });
      },
    };
  };
  return { printer, events };
}

function publishedPayloads(events) {
  return events.filter((e) => e.action === "publish").map((e) => e.payload);
}

// ---------------------------------------------------------------------------
// 1. Pure G-code & safety bounds validation (move_bed_z)
// ---------------------------------------------------------------------------
test("buildBedZMotionGcode generates exact absolute and relative Z sequences for P2S", () => {
  const absPlan = buildBedZMotionGcode({ bambuModel: "p2s", zMm: 150, speedMmMin: 900, homeFirst: true });
  assert.equal(absPlan.model, "p2s");
  assert.equal(absPlan.mode, "absolute");
  assert.equal(absPlan.maxZMm, 256);
  assert.deepEqual(absPlan.gcodes, ["G28 Z", "G90", "G1 Z150 F900"]);

  const relPlan = buildBedZMotionGcode({ bambuModel: "p2s", deltaZMm: 18 });
  assert.equal(relPlan.mode, "relative");
  assert.equal(relPlan.speedMmMin, 600);
  assert.deepEqual(relPlan.gcodes, ["G91", "G1 Z18 F600", "G90"]);
});

test("buildBedZMotionGcode rejects unsafe bounds, ambiguous targets, and invalid models", () => {
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", zMm: 257 }), /build-height limit/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", zMm: -1 }), /build-height limit/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "a1mini", zMm: 185 }), /build-height limit/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", deltaZMm: 0 }), /non-zero/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", deltaZMm: 120 }), /relative step limit/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", zMm: 100, deltaZMm: 10 }), /not both/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", deltaZMm: 10, homeFirst: true }), /absolute/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "p2s", zMm: 100, speedMmMin: 5000 }), /speed_mm_min/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "x2d", zMm: 100 }), /not supported on X2D/i);
  assert.throws(() => buildBedZMotionGcode({ bambuModel: "unknown", zMm: 100 }), /known bambu_model/i);
});

// ---------------------------------------------------------------------------
// 2. BambuImplementation.moveBedZ mocked MQTT dispatch & safety gates
// ---------------------------------------------------------------------------
test("moveBedZ dispatches GCodeLineCommand over MQTT when P2S is idle", async () => {
  const { printer, events } = mockPrinter(mockSafetyStatus({ model: "p2s", state: "IDLE" }));
  const res = await printer.moveBedZ(host, serial, token, {
    bambuModel: "p2s",
    zMm: 150,
    speedMmMin: 600,
  });
  assert.equal(res.status, "success");
  assert.deepEqual(res.gcodes, ["G90", "G1 Z150 F600"]);

  const sent = publishedPayloads(events);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].print.command, "gcode_line");
  assert.match(sent[0].print.param, /G90\s*\nG1 Z150 F600/);
});

test("moveBedZ relative step restores G90 after G91 move", async () => {
  const { printer, events } = mockPrinter(mockSafetyStatus({ model: "p2s", state: "FINISH" }));
  const res = await printer.moveBedZ(host, serial, token, {
    bambuModel: "p2s",
    deltaZMm: -15,
    speedMmMin: 300,
  });
  assert.equal(res.status, "success");
  assert.deepEqual(res.gcodes, ["G91", "G1 Z-15 F300", "G90"]);
  assert.equal(publishedPayloads(events).length, 1);
});

for (const [label, status] of [
  ["actively printing (RUNNING)", mockSafetyStatus({ state: "RUNNING" })],
  ["paused print (PAUSE)", mockSafetyStatus({ state: "PAUSE" })],
  ["active print_error", mockSafetyStatus({ printError: 0x05000001 })],
  ["model identity mismatch", mockSafetyStatus({ model: "p1s" })],
  ["stale MQTT telemetry", mockSafetyStatus({ ageMs: 30_000 })],
]) {
  test(`moveBedZ refuses dispatch when ${label}`, async () => {
    const { printer, events } = mockPrinter(status);
    await assert.rejects(
      printer.moveBedZ(host, serial, token, { bambuModel: "p2s", zMm: 150 }),
      /state|RUNNING|PAUSE|busy|error|mismatch|fresh|stale/i
    );
    assert.deepEqual(publishedPayloads(events), [], "refused motion must publish nothing");
  });
}

// ---------------------------------------------------------------------------
// 3. Toolhead / Nozzle control (control_toolhead) tests
// ---------------------------------------------------------------------------
test("buildToolheadControlGcode supports move, home, park, and hot extrude/retract", () => {
  const moveAbs = buildToolheadControlGcode({ bambuModel: "p2s", action: "move", xMm: 128, yMm: 200 });
  assert.deepEqual(moveAbs.gcodes, ["G90", "G1 X128 Y200 F3000"]);

  const moveRel = buildToolheadControlGcode({ bambuModel: "p2s", action: "move", deltaXMm: 10, deltaYMm: -20, speedMmMin: 2400 });
  assert.deepEqual(moveRel.gcodes, ["G91", "G1 X10 Y-20 F2400", "G90"]);

  const homeXY = buildToolheadControlGcode({ bambuModel: "p2s", action: "home", axes: "xy" });
  assert.deepEqual(homeXY.gcodes, ["G28 X Y", "G90"]);

  const parkP2S = buildToolheadControlGcode({ bambuModel: "p2s", action: "park" });
  assert.deepEqual(parkP2S.gcodes, ["G90", "G1 X250 Y250 F6000"]);

  const parkMini = buildToolheadControlGcode({ bambuModel: "a1mini", action: "park" });
  assert.deepEqual(parkMini.gcodes, ["G90", "G1 X174 Y174 F6000"]);

  const extrude = buildToolheadControlGcode({ bambuModel: "p2s", action: "extrude", lengthMm: 12 }, 215);
  assert.deepEqual(extrude.gcodes, ["M83", "G1 E12 F180", "M82"]);

  const retract = buildToolheadControlGcode({ bambuModel: "p2s", action: "retract", lengthMm: 5, speedMmMin: 300 }, 200);
  assert.deepEqual(retract.gcodes, ["M83", "G1 E-5 F300", "M82"]);
});

test("extractObservedNozzleTempC decodes legacy and packed extruder temperatures", () => {
  assert.equal(extractObservedNozzleTempC({ nozzle_temper: 215.5 }), 215.5);
  assert.equal(extractObservedNozzleTempC({ device: { extruder: { info: [{ temp: (220 << 16) | 212 }] } } }), 212);
  assert.equal(extractObservedNozzleTempC({}), undefined);
});

test("controlToolhead parks P2S toolhead cleanly and rejects out-of-bounds XY", async () => {
  const { printer, events } = mockPrinter(mockSafetyStatus({ model: "p2s", state: "IDLE" }));
  const res = await printer.controlToolhead(host, serial, token, { bambuModel: "p2s", action: "park" });
  assert.equal(res.status, "success");
  assert.deepEqual(res.gcodes, ["G90", "G1 X250 Y250 F6000"]);
  assert.equal(publishedPayloads(events).length, 1);

  await assert.rejects(
    printer.controlToolhead(host, serial, token, { bambuModel: "p2s", action: "move", xMm: 260, yMm: 100 }),
    /safe X limit/i
  );
  // Out-of-bounds validation happens before connecting, so publish count stays 1.
  assert.equal(publishedPayloads(events).length, 1);
});

test("controlToolhead enforces cold-extrusion guard and blocks motion while printing", async () => {
  // Cold nozzle (45 C) must refuse extrude without publishing
  const cold = mockPrinter(mockSafetyStatus({ model: "p2s", state: "IDLE", nozzleTemper: 45 }));
  await assert.rejects(
    cold.printer.controlToolhead(host, serial, token, { bambuModel: "p2s", action: "extrude", lengthMm: 10 }),
    /Cold extrude refused/i
  );
  assert.deepEqual(publishedPayloads(cold.events), []);

  // Hot nozzle (215 C) succeeds
  const hot = mockPrinter(mockSafetyStatus({ model: "p2s", state: "IDLE", nozzleTemper: 215 }));
  const ok = await hot.printer.controlToolhead(host, serial, token, {
    bambuModel: "p2s",
    action: "retract",
    lengthMm: 6,
  });
  assert.equal(ok.status, "success");
  assert.equal(ok.observed_nozzle_temp_c, 215);
  assert.deepEqual(ok.gcodes, ["M83", "G1 E-6 F180", "M82"]);
  assert.equal(publishedPayloads(hot.events).length, 1);

  // Actively printing must block toolhead park/move/home
  const busy = mockPrinter(mockSafetyStatus({ model: "p2s", state: "RUNNING", nozzleTemper: 220 }));
  await assert.rejects(
    busy.printer.controlToolhead(host, serial, token, { bambuModel: "p2s", action: "home", axes: "xy" }),
    /RUNNING|busy|state/i
  );
  assert.deepEqual(publishedPayloads(busy.events), []);
});

// ---------------------------------------------------------------------------
// 4. End-to-end MCP stdio discovery check (with network hard-blocked!)
// ---------------------------------------------------------------------------
test("MCP server advertises move_bed_z and control_toolhead with annotations and remote scope", async (t) => {
  const dir = await trackedMkdtemp(join(tmpdir(), "bambu-motion-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", noNetworkPreload, entry],
    cwd: dir,
    stderr: "pipe",
    env: {
      HOME: dir,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p2s",
      PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: serial,
      BAMBU_TOKEN: token,
      INSPECTION_NETWORK_LOG: join(dir, "network.log"),
    },
  });
  transport.stderr.on("data", () => {});
  const client = new Client({ name: "motion-control-test", version: "1" }, { capabilities: {} });
  t.after(async () => {
    await client.close();
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.ok(byName.move_bed_z, "move_bed_z tool must be registered");
  assert.equal(byName.move_bed_z.annotations.readOnlyHint, false);
  assert.equal(byName.move_bed_z.annotations.openWorldHint, true);
  assert.equal(byName.move_bed_z._meta["counterpart/remote"].scope, "control");

  assert.ok(byName.control_toolhead, "control_toolhead tool must be registered");
  assert.equal(byName.control_toolhead.annotations.readOnlyHint, false);
  assert.equal(byName.control_toolhead.annotations.openWorldHint, true);
  assert.equal(byName.control_toolhead._meta["counterpart/remote"].scope, "control");
});

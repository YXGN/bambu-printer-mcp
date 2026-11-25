/**
 * Offline unit & MCP stdio contract tests for:
 *  1) Multi-object single-plate slicing (`slice_plate`, `validatePlateSlicePlan`, `injectPerObjectModelSettings`)
 *  2) Explicit non-fatal HMS acknowledgment (`acknowledged_hms_codes`) on `print_3mf`
 *
 * Strictly zero network traffic: printer interactions use in-memory mocks and the no-network preload.
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
import {
  injectPerObjectModelSettings,
  validatePlateSlicePlan,
} from "../dist/slicer/plate-slice.js";
import { validatePrinterState } from "../dist/safety/printer-state.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const noNetworkPreload = fileURLToPath(new URL("./fixtures/inspection-no-network.mjs", import.meta.url));

test("validatePlateSlicePlan validates per-part overrides and isolates plate defaults", () => {
  const plan = validatePlateSlicePlan({
    bambuModel: "p2s",
    machineLeaf: "Bambu Lab P2S 0.4 nozzle",
    tempDir: tmpdir(),
    nozzleType: "hardened_steel",
    filamentColor: "#8e9089",
    wallLoops: 4,
    sparseInfillDensity: "25%",
    sparseInfillPattern: "gyroid",
    parts: [
      {
        stl_path: "/tmp/01B.stl",
        enable_support: true,
        support_type: "tree(auto)",
        support_on_build_plate_only: true,
        brim_type: "no_brim",
      },
      {
        stl_path: "/tmp/03.stl",
        sparse_infill_density: "100%",
        enable_support: false,
        brim_width: 5,
      },
      {
        stl_path: "/tmp/03b.stl",
        enable_support: false,
        copies: 2,
      },
    ],
  });

  assert.equal(plan.model, "p2s");
  assert.equal(plan.bedType, "textured_plate");
  assert.equal(plan.bedTypeDisplay, "Textured PEI Plate");
  assert.equal(plan.filamentColor, "#8E9089");
  // Plate defaults stay clean when per-part support/brim is configured
  assert.equal(plan.plateProcessOverrides.enable_support, "0");
  assert.equal(plan.plateProcessOverrides.brim_type, "no_brim");
  assert.equal(plan.plateProcessOverrides.wall_loops, "4");
  assert.equal(plan.plateProcessOverrides.sparse_infill_density, "25%");
  assert.equal(plan.plateProcessOverrides.sparse_infill_pattern, "gyroid");

  assert.equal(plan.parts[0].metadata.enable_support, "1");
  assert.equal(plan.parts[0].metadata.support_type, "tree(auto)");
  assert.equal(plan.parts[0].metadata.support_on_build_plate_only, "1");
  assert.equal(plan.parts[1].metadata.sparse_infill_density, "100%");
  assert.equal(plan.parts[1].metadata.brim_type, "outer_only");
  assert.equal(plan.parts[1].metadata.brim_width, "5");
  assert.equal(plan.parts[2].copies, 2);
});

test("validatePlateSlicePlan rejects empty parts, bad colors, bad extensions, and status-only models", () => {
  assert.throws(() => validatePlateSlicePlan({ bambuModel: "p2s", machineLeaf: "x", tempDir: tmpdir(), parts: [] }), /at least one part/i);
  assert.throws(() => validatePlateSlicePlan({ bambuModel: "p2s", machineLeaf: "x", tempDir: tmpdir(), parts: [{ stl_path: "/tmp/a.txt" }] }), /\.stl/i);
  assert.throws(() => validatePlateSlicePlan({ bambuModel: "p2s", machineLeaf: "x", tempDir: tmpdir(), filamentColor: "grey", parts: [{ stl_path: "/tmp/a.stl" }] }), /hex color/i);
  assert.throws(() => validatePlateSlicePlan({ bambuModel: "p2s", machineLeaf: "x", tempDir: tmpdir(), parts: [{ stl_path: "/tmp/a.stl", brim_width: 80 }] }), /between 0 and 50/i);
  assert.throws(() => validatePlateSlicePlan({ bambuModel: "h3c", machineLeaf: "x", tempDir: tmpdir(), parts: [{ stl_path: "/tmp/a.stl" }] }), /status only/i);
});

test("injectPerObjectModelSettings injects metadata only at <object> level and escapes XML attributes", () => {
  const sampleXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <object id="4">',
    '    <metadata key="name" value="p01_01B.stl"/>',
    '    <metadata key="extruder" value="1"/>',
    '    <part id="3" subtype="normal_part">',
    '      <metadata key="name" value="p01_01B.stl"/>',
    '    </part>',
    '  </object>',
    '  <object id="2">',
    '    <metadata key="name" value="p02_03.stl"/>',
    '    <part id="1" subtype="normal_part">',
    '      <metadata key="name" value="p02_03.stl"/>',
    '    </part>',
    '  </object>',
    '</config>',
  ].join("\n");

  const patched = injectPerObjectModelSettings(sampleXml, [
    {
      stagedFileName: "p01_01B.stl",
      displayName: '01B "Base" & Yoke',
      metadata: { enable_support: "1", support_type: "tree(auto)", support_on_build_plate_only: "1" },
    },
    {
      stagedFileName: "p02_03.stl",
      displayName: "03_pin",
      metadata: { brim_type: "outer_only", brim_width: "5", sparse_infill_density: "100%" },
    },
  ]);

  // Object 4 gets escaped name + support metadata exactly once (not duplicated under <part>)
  assert.match(patched, /<metadata key="name" value="01B &quot;Base&quot; &amp; Yoke"\/>/);
  assert.equal((patched.match(/key="enable_support"/g) || []).length, 1);
  assert.equal((patched.match(/key="brim_width"/g) || []).length, 1);
  assert.match(patched, /<part id="3" subtype="normal_part">\s*<metadata key="name" value="p01_01B\.stl"\/>\s*<\/part>/);
});

test("validatePrinterState respects explicit acknowledgedHmsCodes for non-fatal HMS but still blocks unacknowledged or fatal HMS", () => {
  const now = Date.now();
  const makeStatus = (hms) => ({
    connected: true,
    model: "p2s",
    status: "FAILED",
    serial: "22E8TESTP2S0001",
    raw: {
      model: "p2s",
      gcode_state: "FAILED",
      print_error: 0,
      fail_reason: "50348044",
      gcode_file: "/usr/etc/print/auto_cali_for_user_param.gcode",
      subtask_name: "auto_cali_for_user_param.gcode",
      nozzle_diameter: "0.4",
      nozzle_type: "HS01",
      hms,
    },
    observation: { source: "mqtt", requestedAt: now - 20, receivedAt: now - 5, identitySource: "report" },
  });

  const nonFatal = [{ attr: 50336000, code: 131074 }]; // HMS 0300-1100-0002-0002 (severity 2)
  const fatal = [{ attr: 0x03001800, code: 0x00010005 }]; // HMS 0300-1800-0001-0005 (severity 1)

  // Default (unacknowledged) still rejects
  assert.throws(
    () => validatePrinterState(makeStatus(nonFatal), { model: "p2s", nozzleDiameters: [0.4], verifyMaterials: false }),
    /HMS 0300-1100-0002-0002/
  );
  // Explicit acknowledgment of severity-2 maintenance reminder passes
  assert.doesNotThrow(() =>
    validatePrinterState(makeStatus(nonFatal), {
      model: "p2s",
      nozzleDiameters: [0.4],
      verifyMaterials: false,
      acknowledgedHmsCodes: ["0300-1100-0002-0002"],
    })
  );
  // Fatal severity-1 fault MUST NEVER pass even if explicitly listed
  assert.throws(
    () => validatePrinterState(makeStatus(fatal), {
      model: "p2s",
      nozzleDiameters: [0.4],
      verifyMaterials: false,
      acknowledgedHmsCodes: ["0300-1800-0001-0005"],
    }),
    /HMS 0300-1800-0001-0005/
  );
});

test("MCP server advertises slice_plate and print_3mf.acknowledged_hms_codes with proper annotations and remote scopes", async (t) => {
  const dir = await trackedMkdtemp(join(tmpdir(), "bambu-plate-slice-mcp-"));
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
      BAMBU_SERIAL: "22E8TESTP2S0001",
      BAMBU_TOKEN: "TEST_TOKEN",
      INSPECTION_NETWORK_LOG: join(dir, "network.log"),
    },
  });
  transport.stderr.on("data", () => {});
  const client = new Client({ name: "plate-slice-test", version: "1" }, { capabilities: {} });
  t.after(async () => {
    await client.close();
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.ok(byName.slice_plate, "slice_plate tool must be registered");
  assert.equal(byName.slice_plate.annotations.readOnlyHint, false);
  assert.equal(byName.slice_plate.annotations.destructiveHint, true);
  assert.equal(byName.slice_plate.annotations.openWorldHint, true);
  assert.equal(byName.slice_plate._meta["counterpart/remote"].scope, "design");
  assert.equal(byName.slice_plate._meta["counterpart/remote"].arguments.stl_path, "path");
  assert.equal(byName.slice_plate._meta["counterpart/remote"].arguments.out_path, "output");
  assert.equal(byName.slice_plate._meta["counterpart/remote"].arguments.bambu_model, "config");

  assert.ok(byName.print_3mf?.inputSchema?.properties?.acknowledged_hms_codes, "print_3mf must expose acknowledged_hms_codes");
});

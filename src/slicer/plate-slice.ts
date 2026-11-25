/**
 * Multi-object single-plate slicing with per-part process overrides (supports,
 * brims, walls, infill) via Bambu Studio CLI, followed by metadata repair and
 * print-file safety inspection.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeModel } from "../safety/limits.js";
import { assertNotStatusOnly } from "../safety/status-only-models.js";
import { readSafe3mfArchive } from "../safety/archive.js";
import { inspectPrintFile, type PrintFileInspection } from "../safety/print-file.js";
import { flattenForCli, detectProfilesRoot } from "./profile-flatten.js";
import { normalize3mfMetadata, xmlAttribute } from "./3mf-xml.js";
import { SUPPORT_TYPES } from "./process-overrides.js";

const execFileAsync = promisify(execFile);

export const PLATE_BRIM_TYPES = [
  "auto_brim",
  "outer_only",
  "inner_only",
  "outer_and_inner",
  "no_brim",
] as const;

export type PlateBrimType = (typeof PLATE_BRIM_TYPES)[number];

export const PLATE_INFILL_PATTERNS = [
  "gyroid",
  "grid",
  "cubic",
  "rectilinear",
  "alignedrectilinear",
  "honeycomb",
  "3dhoneycomb",
  "triangles",
  "adaptivecubic",
  "supportcubic",
  "crosshatch",
] as const;

export const PLATE_BED_TYPE_DISPLAY: Readonly<Record<string, string>> = {
  textured_plate: "Textured PEI Plate",
  cool_plate: "Cool Plate",
  engineering_plate: "Engineering Plate",
  hot_plate: "High Temp Plate",
  supertack_plate: "Bambu Cool Plate SuperTack",
};

export interface PlatePartSpec {
  stl_path: string;
  name?: string;
  copies?: number;
  wall_loops?: number;
  sparse_infill_density?: string;
  sparse_infill_pattern?: string;
  enable_support?: boolean;
  support_type?: (typeof SUPPORT_TYPES)[number];
  support_on_build_plate_only?: boolean;
  support_threshold_angle?: number;
  brim_type?: PlateBrimType;
  brim_width?: number;
}

export interface PlateSliceOptions {
  parts: PlatePartSpec[];
  bambuModel: string;
  machineLeaf: string;
  processLeaf?: string;
  filamentLeaf?: string;
  filamentColor?: string;
  nozzleDiameter?: string;
  nozzleType?: string;
  nozzleVolumeType?: "Standard" | "High Flow";
  bedType?: string;
  layerHeight?: number;
  wallLoops?: number;
  sparseInfillDensity?: string;
  sparseInfillPattern?: string;
  enableSupport?: boolean;
  supportType?: (typeof SUPPORT_TYPES)[number];
  supportOnBuildPlateOnly?: boolean;
  brimType?: PlateBrimType;
  brimWidth?: number;
  outPath?: string;
  slicerPath?: string;
  tempDir: string;
}

export interface ValidatedPlatePart {
  stlPath: string;
  displayName: string;
  copies: number;
  metadata: Record<string, string>;
}

export interface ValidatedPlatePlan {
  model: string;
  nozzleDiameter: string;
  nozzleType?: string;
  nozzleVolumeType: "Standard" | "High Flow";
  bedType: string;
  bedTypeDisplay: string;
  filamentColor?: string;
  plateProcessOverrides: Record<string, string>;
  parts: ValidatedPlatePart[];
}

export interface SlicedPlateSummary {
  prediction_seconds?: number;
  estimated_time?: string;
  weight_g?: number;
  length_m?: number;
  total_layers?: number;
  max_z_height_mm?: number;
  support_used?: boolean;
  bed_type?: string;
  filament_colors?: string[];
  bbox_all?: number[];
  objects: Array<{ name: string; id?: number; bbox?: number[] }>;
}

export interface PlateSliceResult {
  status: "success";
  three_mf_path: string;
  model: string;
  bed_type: string;
  nozzle_diameter: string;
  nozzle_type?: string;
  nozzle_volume_type: "Standard" | "High Flow";
  machine_profile: string;
  process_profile: string;
  filament_profile: string;
  filament_color?: string;
  parts_count: number;
  summary: SlicedPlateSummary;
  inspection: {
    model: string;
    nozzle_diameters: number[];
    nozzle_types?: string[];
    nozzle_flows?: string[];
    materials: string[];
    used_filament_positions: number[];
    max_nozzle_temperature: number;
    max_bed_temperature: number;
    max_chamber_temperature: number;
    plate_internal_path?: string;
  };
}

function validatePercentage(value: unknown, field: string): string {
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(value) : null;
  if (!match || Number(match[1]) > 100) {
    throw new Error(`${field} must be a percentage from 0% to 100%, such as "25%".`);
  }
  return `${Number(match[1])}%`;
}

function validateWallLoops(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error(`${field} must be an integer from 0 to 1000.`);
  }
  return String(value);
}

function validateSupportType(value: unknown, field: string): string {
  if (typeof value !== "string" || !(SUPPORT_TYPES as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${SUPPORT_TYPES.join(", ")}.`);
  }
  return value;
}

function validateBrimType(value: unknown, field: string): PlateBrimType {
  if (typeof value !== "string" || !(PLATE_BRIM_TYPES as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${PLATE_BRIM_TYPES.join(", ")}.`);
  }
  return value as PlateBrimType;
}

function validateBrimWidth(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 50) {
    throw new Error(`${field} must be a finite number between 0 and 50 mm.`);
  }
  return String(Math.round(value * 100) / 100);
}

function validateInfillPattern(value: unknown, field: string): string {
  if (typeof value !== "string" || !(PLATE_INFILL_PATTERNS as readonly string[]).includes(value.trim().toLowerCase())) {
    throw new Error(`${field} must be one of: ${PLATE_INFILL_PATTERNS.join(", ")}.`);
  }
  return value.trim().toLowerCase();
}

function validateThresholdAngle(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 90) {
    throw new Error(`${field} must be an integer between 0 and 90 degrees.`);
  }
  return String(value);
}

/**
 * Pure validation of a multi-part plate slice plan (no filesystem or slicer
 * execution beyond checking path syntax; caller/slicePlate verifies files exist).
 */
export function validatePlateSlicePlan(options: PlateSliceOptions): ValidatedPlatePlan {
  assertNotStatusOnly(options.bambuModel);
  const model = normalizeModel(options.bambuModel);
  if (!model) {
    throw new Error(`A supported bambu_model is required for slice_plate (received '${String(options.bambuModel ?? "")}').`);
  }

  if (!Array.isArray(options.parts) || options.parts.length === 0) {
    throw new Error("slice_plate requires at least one part in 'parts'.");
  }
  if (options.parts.length > 64) {
    throw new Error("slice_plate supports at most 64 part entries per plate.");
  }

  const nozzleDiameter = String(options.nozzleDiameter ?? "0.4").trim();
  if (!["0.2", "0.4", "0.6", "0.8"].includes(nozzleDiameter)) {
    throw new Error(`Unsupported nozzle_diameter '${nozzleDiameter}'. Use one of: 0.2, 0.4, 0.6, 0.8.`);
  }
  const nozzleNum = Number(nozzleDiameter);

  const bedType = String(options.bedType ?? "textured_plate").trim().toLowerCase();
  const bedTypeDisplay = PLATE_BED_TYPE_DISPLAY[bedType];
  if (!bedTypeDisplay) {
    throw new Error(`Unsupported bed_type '${bedType}'. Use one of: ${Object.keys(PLATE_BED_TYPE_DISPLAY).join(", ")}.`);
  }

  let filamentColor: string | undefined;
  if (options.filamentColor !== undefined) {
    const c = String(options.filamentColor).trim();
    if (!/^#[0-9A-Fa-f]{6}$/.test(c)) {
      throw new Error(`filament_color must be a 6-digit hex color like '#8E9089' (received '${c}').`);
    }
    filamentColor = c.toUpperCase();
  }

  const plateProcessOverrides: Record<string, string> = {};
  if (options.layerHeight !== undefined) {
    if (typeof options.layerHeight !== "number" || !Number.isFinite(options.layerHeight) || options.layerHeight <= 0 || options.layerHeight > nozzleNum) {
      throw new Error(`layer_height must be > 0 and <= nozzle_diameter (${nozzleNum} mm).`);
    }
    plateProcessOverrides.layer_height = String(Number(options.layerHeight.toFixed(4)));
  }
  if (options.wallLoops !== undefined) {
    plateProcessOverrides.wall_loops = validateWallLoops(options.wallLoops, "wall_loops");
  }
  if (options.sparseInfillDensity !== undefined) {
    plateProcessOverrides.sparse_infill_density = validatePercentage(options.sparseInfillDensity, "sparse_infill_density");
  }
  if (options.sparseInfillPattern !== undefined) {
    plateProcessOverrides.sparse_infill_pattern = validateInfillPattern(options.sparseInfillPattern, "sparse_infill_pattern");
  }
  if (options.enableSupport !== undefined) {
    plateProcessOverrides.enable_support = options.enableSupport ? "1" : "0";
  }
  if (options.supportType !== undefined) {
    plateProcessOverrides.support_type = validateSupportType(options.supportType, "support_type");
  }
  if (options.supportOnBuildPlateOnly !== undefined) {
    plateProcessOverrides.support_on_build_plate_only = options.supportOnBuildPlateOnly ? "1" : "0";
  }
  if (options.brimType !== undefined) {
    plateProcessOverrides.brim_type = validateBrimType(options.brimType, "brim_type");
  }
  if (options.brimWidth !== undefined) {
    plateProcessOverrides.brim_width = validateBrimWidth(options.brimWidth, "brim_width");
  }

  let totalInstances = 0;
  let anyPerObjectSupport = false;
  let anyPerObjectBrim = false;
  const parts: ValidatedPlatePart[] = options.parts.map((part, idx) => {
    const label = `parts[${idx}]`;
    const stlPath = typeof part?.stl_path === "string" ? part.stl_path.trim() : "";
    if (!stlPath) throw new Error(`${label}.stl_path is required.`);
    if (!/\.(stl|obj|3mf)$/i.test(stlPath)) {
      throw new Error(`${label}.stl_path must point to an .stl, .obj, or .3mf file (got '${stlPath}').`);
    }
    const copies = part.copies === undefined ? 1 : part.copies;
    if (typeof copies !== "number" || !Number.isInteger(copies) || copies < 1 || copies > 20) {
      throw new Error(`${label}.copies must be an integer from 1 to 20.`);
    }
    totalInstances += copies;

    const metadata: Record<string, string> = {};
    if (part.wall_loops !== undefined) {
      metadata.wall_loops = validateWallLoops(part.wall_loops, `${label}.wall_loops`);
    }
    if (part.sparse_infill_density !== undefined) {
      metadata.sparse_infill_density = validatePercentage(part.sparse_infill_density, `${label}.sparse_infill_density`);
    }
    if (part.sparse_infill_pattern !== undefined) {
      metadata.sparse_infill_pattern = validateInfillPattern(part.sparse_infill_pattern, `${label}.sparse_infill_pattern`);
    }
    if (part.enable_support !== undefined) {
      metadata.enable_support = part.enable_support ? "1" : "0";
      anyPerObjectSupport = true;
    }
    if (part.support_type !== undefined) {
      metadata.support_type = validateSupportType(part.support_type, `${label}.support_type`);
      if (part.enable_support === undefined) metadata.enable_support = "1";
      anyPerObjectSupport = true;
    }
    if (part.support_on_build_plate_only !== undefined) {
      metadata.support_on_build_plate_only = part.support_on_build_plate_only ? "1" : "0";
      anyPerObjectSupport = true;
    }
    if (part.support_threshold_angle !== undefined) {
      metadata.support_threshold_angle = validateThresholdAngle(part.support_threshold_angle, `${label}.support_threshold_angle`);
    }
    if (part.brim_type !== undefined) {
      metadata.brim_type = validateBrimType(part.brim_type, `${label}.brim_type`);
      anyPerObjectBrim = true;
    }
    if (part.brim_width !== undefined) {
      metadata.brim_width = validateBrimWidth(part.brim_width, `${label}.brim_width`);
      if (part.brim_type === undefined && Number(metadata.brim_width) > 0) {
        metadata.brim_type = "outer_only";
      }
      anyPerObjectBrim = true;
    }

    const displayName = (part.name?.trim() || path.basename(stlPath)).replace(/[\r\n]/g, " ");
    return { stlPath, displayName, copies, metadata };
  });

  if (totalInstances > 64) {
    throw new Error(`Total object instances (${totalInstances}) exceeds the per-plate limit of 64.`);
  }

  // When parts configure support or brim individually, keep plate defaults clean so
  // non-flagged parts do not inherit unintended support or brim.
  if (anyPerObjectSupport && plateProcessOverrides.enable_support === undefined) {
    plateProcessOverrides.enable_support = "0";
  }
  if (anyPerObjectBrim && plateProcessOverrides.brim_type === undefined) {
    plateProcessOverrides.brim_type = "no_brim";
  }

  return {
    model,
    nozzleDiameter,
    nozzleType: options.nozzleType,
    nozzleVolumeType: options.nozzleVolumeType ?? "Standard",
    bedType,
    bedTypeDisplay,
    filamentColor,
    plateProcessOverrides,
    parts,
  };
}

/**
 * Inject per-object `<metadata key="..." value="..."/>` tags ONLY on the top-level
 * `<object id="...">` element (never duplicated inside child `<part>` elements).
 * Matches each `<object>` block by its staged filename prefix/exact name.
 */
export function injectPerObjectModelSettings(
  xml: string,
  stagedParts: ReadonlyArray<{ stagedFileName: string; displayName: string; metadata: Record<string, string> }>
): string {
  const byStaged = new Map(stagedParts.map((entry) => [entry.stagedFileName, entry]));
  return xml.replace(
    /(<object\s+id="\d+">\s*\n\s*<metadata\s+key="name"\s+value=")([^"]+)("\s*\/>)/g,
    (full, prefix: string, rawName: string, suffix: string) => {
      const matched = byStaged.get(rawName)
        ?? stagedParts.find((entry) => rawName === entry.stagedFileName || rawName === path.basename(entry.stagedFileName, path.extname(entry.stagedFileName)));
      if (!matched) return full;
      const lines = Object.entries(matched.metadata).map(
        ([k, v]) => `    <metadata key="${xmlAttribute(k)}" value="${xmlAttribute(v)}"/>`
      );
      const renamedTag = `${prefix}${xmlAttribute(matched.displayName)}${suffix}`;
      return lines.length > 0 ? `${renamedTag}\n${lines.join("\n")}` : renamedTag;
    }
  );
}

/**
 * Read a machine leaf profile's default print & filament profile names from
 * BambuStudio's bundled BBL machine JSON (walking `inherits` if needed).
 */
export async function resolveMachineDefaultProfiles(
  profilesRoot: string,
  machineLeaf: string
): Promise<{ defaultProcess?: string; defaultFilament?: string }> {
  const machineDir = path.join(profilesRoot, "BBL", "machine");
  const files = await fs.readdir(machineDir);
  const byName = new Map<string, Record<string, any>>();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await fs.readFile(path.join(machineDir, file), "utf8"));
      if (typeof data?.name === "string") byName.set(data.name, data);
    } catch {
      // Ignore unrelated malformed profile files
    }
  }
  let current = byName.get(machineLeaf);
  let defaultProcess: string | undefined;
  let defaultFilament: string | undefined;
  const visited = new Set<string>();
  while (current && !visited.has(String(current.name))) {
    visited.add(String(current.name));
    if (!defaultProcess && typeof current.default_print_profile === "string" && current.default_print_profile.trim()) {
      defaultProcess = current.default_print_profile.trim();
    }
    if (!defaultFilament) {
      const rawFil = Array.isArray(current.default_filament_profile)
        ? current.default_filament_profile[0]
        : current.default_filament_profile;
      if (typeof rawFil === "string" && rawFil.trim()) defaultFilament = rawFil.trim();
    }
    if (defaultProcess && defaultFilament) break;
    current = typeof current.inherits === "string" ? byName.get(current.inherits) : undefined;
  }
  return { defaultProcess, defaultFilament };
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  return h > 0 ? `${h}h ${m}m ${rem}s` : m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

/** Extract concise plate summary metrics from a sliced 3MF archive. */
export async function parseSlicedPlateSummary(threeMfPath: string): Promise<SlicedPlateSummary> {
  const { zip } = await readSafe3mfArchive(threeMfPath);
  const summary: SlicedPlateSummary = { objects: [] };

  const sliceInfo = await zip.file("Metadata/slice_info.config")?.async("string");
  if (sliceInfo) {
    const readMeta = (key: string) => new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"\\s*/>`).exec(sliceInfo)?.[1];
    const pred = Number(readMeta("prediction"));
    if (Number.isFinite(pred) && pred > 0) {
      summary.prediction_seconds = pred;
      summary.estimated_time = formatDuration(pred);
    }
    const weight = Number(readMeta("weight"));
    if (Number.isFinite(weight) && weight > 0) summary.weight_g = weight;
    const sup = readMeta("support_used");
    if (sup === "true" || sup === "false") summary.support_used = sup === "true";
    const usedM = /used_m="([0-9.]+)"/.exec(sliceInfo)?.[1];
    if (usedM && Number.isFinite(Number(usedM))) summary.length_m = Number(usedM);
  }

  const plateJsonRaw = await zip.file("Metadata/plate_1.json")?.async("string");
  if (plateJsonRaw) {
    try {
      const pj = JSON.parse(plateJsonRaw);
      if (typeof pj.bed_type === "string") summary.bed_type = pj.bed_type;
      if (Array.isArray(pj.filament_colors)) summary.filament_colors = pj.filament_colors;
      if (Array.isArray(pj.bbox_all)) summary.bbox_all = pj.bbox_all.map((v: number) => Math.round(v * 10) / 10);
      if (Array.isArray(pj.bbox_objects)) {
        summary.objects = pj.bbox_objects.map((o: any) => ({
          name: String(o.name ?? ""),
          ...(typeof o.id === "number" ? { id: o.id } : {}),
          ...(Array.isArray(o.bbox) ? { bbox: o.bbox.map((v: number) => Math.round(v * 10) / 10) } : {}),
        }));
      }
    } catch {
      // Ignore malformed optional metadata
    }
  }

  const gcode = await zip.file("Metadata/plate_1.gcode")?.async("string");
  if (gcode) {
    const head = gcode.slice(0, 8192);
    const layers = /;\s*total layer number:\s*(\d+)/i.exec(head)?.[1];
    if (layers) summary.total_layers = Number(layers);
    const maxZ = /;\s*max_z_height:\s*([0-9.]+)/i.exec(head)?.[1];
    if (maxZ) summary.max_z_height_mm = Number(maxZ);
  }

  return summary;
}

/**
 * Arrange and slice multiple STL/3MF/OBJ parts onto a single plate with
 * per-object overrides using Bambu Studio CLI, then verify the output via
 * inspectPrintFile before returning.
 */
export async function slicePlate(options: PlateSliceOptions): Promise<PlateSliceResult> {
  const plan = validatePlateSlicePlan(options);

  for (const part of plan.parts) {
    if (!existsSync(part.stlPath)) {
      throw new Error(`Input model file does not exist: ${part.stlPath}`);
    }
  }

  const slicerPath = options.slicerPath?.trim()
    || process.env.SLICER_PATH?.trim()
    || "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
  if (!existsSync(slicerPath)) {
    throw new Error(`Bambu Studio CLI not found at '${slicerPath}'. Set SLICER_PATH or pass slicer_path.`);
  }

  const profilesRoot = detectProfilesRoot(slicerPath, "bambustudio");
  const defaults = await resolveMachineDefaultProfiles(profilesRoot, options.machineLeaf);
  const resolveLeafName = async (value?: string): Promise<string | undefined> => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed.toLowerCase().endsWith(".json") && existsSync(trimmed)) {
      const parsed = JSON.parse(await fs.readFile(trimmed, "utf8"));
      if (typeof parsed?.name === "string" && parsed.name.trim()) return parsed.name.trim();
    }
    return trimmed;
  };
  const processLeaf = (await resolveLeafName(options.processLeaf)) || defaults.defaultProcess;
  const filamentLeaf = (await resolveLeafName(options.filamentLeaf)) || defaults.defaultFilament;
  if (!processLeaf) {
    throw new Error(`Could not determine default process profile for '${options.machineLeaf}'. Specify process_profile explicitly.`);
  }
  if (!filamentLeaf) {
    throw new Error(`Could not determine default filament profile for '${options.machineLeaf}'. Specify filament_profile explicitly.`);
  }

  const workDir = path.join(options.tempDir, `slice-plate-${crypto.randomUUID().slice(0, 12)}`);
  await fs.mkdir(workDir, { recursive: true });

  const runStudio = async (args: string[]) => {
    try {
      return await execFileAsync(slicerPath, args, {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180_000,
      });
    } catch (error: any) {
      const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`Bambu Studio CLI failed (code ${error?.code ?? "unknown"}): ${detail || error?.message || String(error)}`);
    }
  };

  try {
    // 1. Flatten official BBL machine + process + filament presets
    const flat = await flattenForCli({
      machineLeaf: options.machineLeaf,
      processLeaf,
      filamentLeaves: [filamentLeaf],
      profilesRoot,
      tempDir: workDir,
      nozzleVolumeType: plan.nozzleVolumeType,
      bedType: plan.bedTypeDisplay,
      ...(plan.filamentColor ? { filamentColours: [plan.filamentColor] } : {}),
    });

    let machinePath = flat.machinePath;
    if (plan.nozzleType) {
      const machJson = JSON.parse(await fs.readFile(flat.machinePath, "utf8"));
      machJson.nozzle_type = plan.nozzleType;
      machinePath = path.join(workDir, "patched-machine.json");
      await fs.writeFile(machinePath, JSON.stringify(machJson, null, 2), "utf8");
    }

    let processPath = flat.processPath;
    if (Object.keys(plan.plateProcessOverrides).length > 0) {
      const procJson = JSON.parse(await fs.readFile(flat.processPath, "utf8"));
      Object.assign(procJson, plan.plateProcessOverrides);
      processPath = path.join(workDir, "patched-process.json");
      await fs.writeFile(processPath, JSON.stringify(procJson, null, 2), "utf8");
    }

    // 2. Stage uniquely named input links/copies so every instance (including copies > 1
    //    or duplicate basenames) maps 1:1 to its <object> entry in model_settings.config.
    const stagedParts: Array<{ stagedPath: string; stagedFileName: string; displayName: string; metadata: Record<string, string> }> = [];
    let instanceIndex = 0;
    for (const part of plan.parts) {
      const ext = path.extname(part.stlPath).toLowerCase() || ".stl";
      const safeStem = path.basename(part.displayName, path.extname(part.displayName))
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 48) || `part_${instanceIndex}`;
      for (let c = 0; c < part.copies; c++) {
        instanceIndex++;
        const stagedFileName = `p${String(instanceIndex).padStart(2, "0")}_${safeStem}${ext}`;
        const stagedPath = path.join(workDir, stagedFileName);
        await fs.copyFile(part.stlPath, stagedPath);
        const displayName = part.copies > 1 ? `${part.displayName}#${c + 1}` : part.displayName;
        stagedParts.push({ stagedPath, stagedFileName, displayName, metadata: part.metadata });
      }
    }

    // 3. Stage A: Build an initial arranged multi-object 3MF
    const arrangedPath = path.join(workDir, "arranged_raw.3mf");
    await runStudio([
      "--load-settings", `${machinePath};${processPath}`,
      "--load-filaments", flat.filamentPaths.join(";"),
      "--arrange", "1",
      "--ensure-on-bed",
      "--export-3mf", arrangedPath,
      ...stagedParts.map((s) => s.stagedPath),
    ]);

    // 4. Stage B: Inject per-object overrides into Metadata/model_settings.config
    const { zip } = await readSafe3mfArchive(arrangedPath);
    const msEntry = zip.file("Metadata/model_settings.config");
    if (!msEntry) {
      throw new Error("Bambu Studio did not emit Metadata/model_settings.config during multi-object arrangement.");
    }
    const patchedXml = injectPerObjectModelSettings(await msEntry.async("string"), stagedParts);
    zip.file("Metadata/model_settings.config", patchedXml);
    const configuredPath = path.join(workDir, "arranged_configured.3mf");
    await fs.writeFile(configuredPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

    // 5. Stage C: Re-arrange WITH support & brim footprints and slice plate 1
    const outPath = options.outPath?.trim()
      ? path.resolve(options.outPath.trim())
      : path.join(options.tempDir, `plate_${plan.model}_${crypto.randomUUID().slice(0, 8)}.3mf`);
    if (!outPath.toLowerCase().endsWith(".3mf")) {
      throw new Error(`out_path must end with '.3mf' (got '${outPath}').`);
    }
    const outDir = path.dirname(outPath);
    await fs.mkdir(outDir, { recursive: true });

    await runStudio([
      "--load-settings", `${machinePath};${processPath}`,
      "--load-filaments", flat.filamentPaths.join(";"),
      "--arrange", "1",
      "--ensure-on-bed",
      "--slice", "0",
      "--outputdir", outDir,
      "--export-3mf", path.basename(outPath),
      configuredPath,
    ]);

    await normalize3mfMetadata(outPath);

    // 6. Safety inspection + summary extraction
    const inspection: PrintFileInspection = await inspectPrintFile(outPath, {
      model: plan.model,
      nozzleDiameters: [Number(plan.nozzleDiameter)],
      plateIndex: 0,
      bedType: plan.bedType,
    });
    const summary = await parseSlicedPlateSummary(outPath);

    return {
      status: "success",
      three_mf_path: outPath,
      model: plan.model,
      bed_type: plan.bedType,
      nozzle_diameter: plan.nozzleDiameter,
      nozzle_type: plan.nozzleType,
      nozzle_volume_type: plan.nozzleVolumeType,
      machine_profile: options.machineLeaf,
      process_profile: processLeaf,
      filament_profile: filamentLeaf,
      filament_color: plan.filamentColor,
      parts_count: stagedParts.length,
      summary,
      inspection: {
        model: inspection.model,
        nozzle_diameters: inspection.nozzleDiameters,
        nozzle_types: inspection.nozzleTypes,
        nozzle_flows: inspection.nozzleFlows,
        materials: inspection.materials,
        used_filament_positions: inspection.usedFilamentPositions,
        max_nozzle_temperature: inspection.maxNozzleTemperature,
        max_bed_temperature: inspection.maxBedTemperature,
        max_chamber_temperature: inspection.maxChamberTemperature,
        plate_internal_path: inspection.plateInternalPath,
      },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

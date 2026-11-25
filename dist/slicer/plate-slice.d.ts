import { SUPPORT_TYPES } from "./process-overrides.js";
export declare const PLATE_BRIM_TYPES: readonly ["auto_brim", "outer_only", "inner_only", "outer_and_inner", "no_brim"];
export type PlateBrimType = (typeof PLATE_BRIM_TYPES)[number];
export declare const PLATE_INFILL_PATTERNS: readonly ["gyroid", "grid", "cubic", "rectilinear", "alignedrectilinear", "honeycomb", "3dhoneycomb", "triangles", "adaptivecubic", "supportcubic", "crosshatch"];
export declare const PLATE_BED_TYPE_DISPLAY: Readonly<Record<string, string>>;
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
    objects: Array<{
        name: string;
        id?: number;
        bbox?: number[];
    }>;
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
/**
 * Pure validation of a multi-part plate slice plan (no filesystem or slicer
 * execution beyond checking path syntax; caller/slicePlate verifies files exist).
 */
export declare function validatePlateSlicePlan(options: PlateSliceOptions): ValidatedPlatePlan;
/**
 * Inject per-object `<metadata key="..." value="..."/>` tags ONLY on the top-level
 * `<object id="...">` element (never duplicated inside child `<part>` elements).
 * Matches each `<object>` block by its staged filename prefix/exact name.
 */
export declare function injectPerObjectModelSettings(xml: string, stagedParts: ReadonlyArray<{
    stagedFileName: string;
    displayName: string;
    metadata: Record<string, string>;
}>): string;
/**
 * Read a machine leaf profile's default print & filament profile names from
 * BambuStudio's bundled BBL machine JSON (walking `inherits` if needed).
 */
export declare function resolveMachineDefaultProfiles(profilesRoot: string, machineLeaf: string): Promise<{
    defaultProcess?: string;
    defaultFilament?: string;
}>;
/** Extract concise plate summary metrics from a sliced 3MF archive. */
export declare function parseSlicedPlateSummary(threeMfPath: string): Promise<SlicedPlateSummary>;
/**
 * Arrange and slice multiple STL/3MF/OBJ parts onto a single plate with
 * per-object overrides using Bambu Studio CLI, then verify the output via
 * inspectPrintFile before returning.
 */
export declare function slicePlate(options: PlateSliceOptions): Promise<PlateSliceResult>;

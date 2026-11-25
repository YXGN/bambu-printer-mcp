export declare const BED_Z_MIN_SPEED_MM_MIN = 60;
export declare const BED_Z_MAX_SPEED_MM_MIN = 1800;
export declare const BED_Z_DEFAULT_SPEED_MM_MIN = 600;
export declare const BED_Z_MAX_RELATIVE_STEP_MM = 100;
export declare const TOOLHEAD_MIN_SPEED_MM_MIN = 300;
export declare const TOOLHEAD_MAX_SPEED_MM_MIN = 12000;
export declare const TOOLHEAD_DEFAULT_SPEED_MM_MIN = 3000;
export declare const TOOLHEAD_PARK_SPEED_MM_MIN = 6000;
export declare const TOOLHEAD_MAX_RELATIVE_STEP_MM = 150;
export declare const TOOLHEAD_PARK_MARGIN_MM = 6;
export declare const EXTRUDER_MIN_SPEED_MM_MIN = 60;
export declare const EXTRUDER_MAX_SPEED_MM_MIN = 600;
export declare const EXTRUDER_DEFAULT_SPEED_MM_MIN = 180;
export declare const EXTRUDER_MAX_LENGTH_MM = 50;
export declare const MIN_SAFE_EXTRUSION_TEMP_C = 170;
export interface BedZMotionOptions {
    bambuModel?: string;
    mode?: "absolute" | "relative";
    zMm?: number;
    deltaZMm?: number;
    speedMmMin?: number;
    homeFirst?: boolean;
}
export interface BedZMotionPlan {
    model: string;
    mode: "absolute" | "relative";
    zMm?: number;
    deltaZMm?: number;
    maxZMm: number;
    speedMmMin: number;
    homeFirst: boolean;
    gcodes: string[];
}
export type ToolheadAction = "move" | "home" | "park" | "extrude" | "retract";
export type HomeAxes = "xy" | "z" | "xyz";
export interface ToolheadControlOptions {
    bambuModel?: string;
    action: ToolheadAction;
    mode?: "absolute" | "relative";
    xMm?: number;
    yMm?: number;
    deltaXMm?: number;
    deltaYMm?: number;
    axes?: HomeAxes;
    lengthMm?: number;
    speedMmMin?: number;
}
export interface ToolheadControlPlan {
    model: string;
    action: ToolheadAction;
    mode?: "absolute" | "relative";
    target?: {
        xMm?: number;
        yMm?: number;
        deltaXMm?: number;
        deltaYMm?: number;
        axes?: HomeAxes;
        lengthMm?: number;
    };
    speedMmMin?: number;
    requiresHotNozzle: boolean;
    gcodes: string[];
}
/**
 * Validate and build a bounded G-code sequence for heatbed Z-axis movement.
 * Note: On Bambu CoreXY printers (P2S/P1S/X1C), Z=0 is at the nozzle and larger Z lowers the heatbed.
 */
export declare function buildBedZMotionGcode(options: BedZMotionOptions): BedZMotionPlan;
/** Extract live reported nozzle temperature in °C from raw MQTT status (supports legacy & packed H2/P2 fields). */
export declare function extractObservedNozzleTempC(raw: Record<string, any> | undefined): number | undefined;
/**
 * Validate and build a bounded G-code sequence for toolhead/nozzle control:
 * - move: absolute (x_mm, y_mm) or relative (delta_x_mm, delta_y_mm) XY positioning
 * - home: G28 X Y / G28 Z / G28
 * - park: move toolhead to rear-right corner to clear chamber space for robotic arms
 * - extrude / retract: controlled relative filament feed with cold-extrusion protection
 */
export declare function buildToolheadControlGcode(options: ToolheadControlOptions, liveNozzleTempC?: number): ToolheadControlPlan;

import { MACHINE_LIMITS, normalizeModel } from "./limits.js";
import { assertNotStatusOnly } from "./status-only-models.js";
export const BED_Z_MIN_SPEED_MM_MIN = 60;
export const BED_Z_MAX_SPEED_MM_MIN = 1800;
export const BED_Z_DEFAULT_SPEED_MM_MIN = 600;
export const BED_Z_MAX_RELATIVE_STEP_MM = 100;
export const TOOLHEAD_MIN_SPEED_MM_MIN = 300;
export const TOOLHEAD_MAX_SPEED_MM_MIN = 12000;
export const TOOLHEAD_DEFAULT_SPEED_MM_MIN = 3000;
export const TOOLHEAD_PARK_SPEED_MM_MIN = 6000;
export const TOOLHEAD_MAX_RELATIVE_STEP_MM = 150;
export const TOOLHEAD_PARK_MARGIN_MM = 6;
export const EXTRUDER_MIN_SPEED_MM_MIN = 60;
export const EXTRUDER_MAX_SPEED_MM_MIN = 600;
export const EXTRUDER_DEFAULT_SPEED_MM_MIN = 180;
export const EXTRUDER_MAX_LENGTH_MM = 50;
export const MIN_SAFE_EXTRUSION_TEMP_C = 170;
function fmtNum(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
}
function requireFinite(name, value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number; received ${String(value)}.`);
    }
    return value;
}
function resolveMotionModel(rawModel) {
    assertNotStatusOnly(rawModel);
    const model = normalizeModel(rawModel);
    if (!model) {
        throw new Error(`A known bambu_model is required before motion control (received '${String(rawModel ?? "")}').`);
    }
    if (model === "x2d") {
        throw new Error("Raw MQTT G-code motion is not supported on X2D; use the printer controls or checked print workflow.");
    }
    return { model, volume: MACHINE_LIMITS[model].volume };
}
/**
 * Validate and build a bounded G-code sequence for heatbed Z-axis movement.
 * Note: On Bambu CoreXY printers (P2S/P1S/X1C), Z=0 is at the nozzle and larger Z lowers the heatbed.
 */
export function buildBedZMotionGcode(options) {
    const { model, volume } = resolveMotionModel(options.bambuModel);
    const maxZMm = volume[2];
    const hasAbs = options.zMm !== undefined;
    const hasRel = options.deltaZMm !== undefined;
    if (hasAbs && hasRel) {
        throw new Error("Provide either z_mm (absolute) or delta_z_mm (relative), not both.");
    }
    if (!hasAbs && !hasRel) {
        throw new Error("Either z_mm (absolute) or delta_z_mm (relative) is required.");
    }
    const mode = options.mode ?? (hasAbs ? "absolute" : "relative");
    if (mode === "absolute" && !hasAbs) {
        throw new Error("mode='absolute' requires z_mm.");
    }
    if (mode === "relative" && !hasRel) {
        throw new Error("mode='relative' requires delta_z_mm.");
    }
    const speedMmMin = options.speedMmMin === undefined
        ? BED_Z_DEFAULT_SPEED_MM_MIN
        : Math.round(requireFinite("speed_mm_min", options.speedMmMin));
    if (speedMmMin < BED_Z_MIN_SPEED_MM_MIN || speedMmMin > BED_Z_MAX_SPEED_MM_MIN) {
        throw new Error(`speed_mm_min must be between ${BED_Z_MIN_SPEED_MM_MIN} and ${BED_Z_MAX_SPEED_MM_MIN} mm/min.`);
    }
    const homeFirst = options.homeFirst === true;
    if (homeFirst && mode === "relative") {
        throw new Error("home_first=true is only supported with absolute z_mm moves.");
    }
    const gcodes = [];
    if (mode === "absolute") {
        const zMm = requireFinite("z_mm", options.zMm);
        if (zMm < 0 || zMm > maxZMm) {
            throw new Error(`${model} z_mm=${zMm} is outside the safe build-height limit [0, ${maxZMm}] mm.`);
        }
        if (homeFirst)
            gcodes.push("G28 Z");
        gcodes.push("G90", `G1 Z${fmtNum(zMm)} F${speedMmMin}`);
        return { model, mode, zMm, maxZMm, speedMmMin, homeFirst, gcodes };
    }
    const deltaZMm = requireFinite("delta_z_mm", options.deltaZMm);
    if (deltaZMm === 0) {
        throw new Error("delta_z_mm must be non-zero.");
    }
    if (Math.abs(deltaZMm) > BED_Z_MAX_RELATIVE_STEP_MM) {
        throw new Error(`delta_z_mm=${deltaZMm} exceeds the single-call relative step limit ±${BED_Z_MAX_RELATIVE_STEP_MM} mm.`);
    }
    // Always restore G90 (absolute positioning) after a relative G91 move.
    gcodes.push("G91", `G1 Z${fmtNum(deltaZMm)} F${speedMmMin}`, "G90");
    return { model, mode, deltaZMm, maxZMm, speedMmMin, homeFirst: false, gcodes };
}
/** Extract live reported nozzle temperature in °C from raw MQTT status (supports legacy & packed H2/P2 fields). */
export function extractObservedNozzleTempC(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    if (typeof raw.nozzle_temper === "number" && Number.isFinite(raw.nozzle_temper)) {
        return raw.nozzle_temper;
    }
    const packed = raw.device?.extruder?.info?.[0]?.temp;
    if (typeof packed === "number" && Number.isFinite(packed)) {
        return packed & 0xffff;
    }
    return undefined;
}
/**
 * Validate and build a bounded G-code sequence for toolhead/nozzle control:
 * - move: absolute (x_mm, y_mm) or relative (delta_x_mm, delta_y_mm) XY positioning
 * - home: G28 X Y / G28 Z / G28
 * - park: move toolhead to rear-right corner to clear chamber space for robotic arms
 * - extrude / retract: controlled relative filament feed with cold-extrusion protection
 */
export function buildToolheadControlGcode(options, liveNozzleTempC) {
    const { model, volume } = resolveMotionModel(options.bambuModel);
    const [maxXMm, maxYMm] = volume;
    const action = options.action;
    if (!["move", "home", "park", "extrude", "retract"].includes(action)) {
        throw new Error(`Unsupported toolhead action '${String(action)}'. Use one of: move, home, park, extrude, retract.`);
    }
    if (action === "home") {
        const axes = options.axes ?? "xy";
        if (!["xy", "z", "xyz"].includes(axes)) {
            throw new Error(`Unsupported home axes '${String(axes)}'. Use one of: xy, z, xyz.`);
        }
        const cmd = axes === "xy" ? "G28 X Y" : axes === "z" ? "G28 Z" : "G28";
        return {
            model,
            action,
            target: { axes },
            requiresHotNozzle: false,
            gcodes: [cmd, "G90"],
        };
    }
    if (action === "park") {
        const speedMmMin = options.speedMmMin === undefined
            ? TOOLHEAD_PARK_SPEED_MM_MIN
            : Math.round(requireFinite("speed_mm_min", options.speedMmMin));
        if (speedMmMin < TOOLHEAD_MIN_SPEED_MM_MIN || speedMmMin > TOOLHEAD_MAX_SPEED_MM_MIN) {
            throw new Error(`speed_mm_min must be between ${TOOLHEAD_MIN_SPEED_MM_MIN} and ${TOOLHEAD_MAX_SPEED_MM_MIN} mm/min.`);
        }
        const xMm = Math.max(0, maxXMm - TOOLHEAD_PARK_MARGIN_MM);
        const yMm = Math.max(0, maxYMm - TOOLHEAD_PARK_MARGIN_MM);
        return {
            model,
            action,
            mode: "absolute",
            target: { xMm, yMm },
            speedMmMin,
            requiresHotNozzle: false,
            gcodes: ["G90", `G1 X${fmtNum(xMm)} Y${fmtNum(yMm)} F${speedMmMin}`],
        };
    }
    if (action === "extrude" || action === "retract") {
        const lengthMm = requireFinite("length_mm", options.lengthMm);
        if (lengthMm <= 0 || lengthMm > EXTRUDER_MAX_LENGTH_MM) {
            throw new Error(`length_mm must be > 0 and <= ${EXTRUDER_MAX_LENGTH_MM} mm.`);
        }
        const speedMmMin = options.speedMmMin === undefined
            ? EXTRUDER_DEFAULT_SPEED_MM_MIN
            : Math.round(requireFinite("speed_mm_min", options.speedMmMin));
        if (speedMmMin < EXTRUDER_MIN_SPEED_MM_MIN || speedMmMin > EXTRUDER_MAX_SPEED_MM_MIN) {
            throw new Error(`Extruder speed_mm_min must be between ${EXTRUDER_MIN_SPEED_MM_MIN} and ${EXTRUDER_MAX_SPEED_MM_MIN} mm/min.`);
        }
        if (liveNozzleTempC !== undefined) {
            if (!Number.isFinite(liveNozzleTempC) || liveNozzleTempC < MIN_SAFE_EXTRUSION_TEMP_C) {
                throw new Error(`Cold ${action} refused: observed nozzle temperature is ${liveNozzleTempC}°C (minimum ${MIN_SAFE_EXTRUSION_TEMP_C}°C required).`);
            }
        }
        const signedLength = action === "extrude" ? lengthMm : -lengthMm;
        return {
            model,
            action,
            mode: "relative",
            target: { lengthMm },
            speedMmMin,
            requiresHotNozzle: true,
            gcodes: ["M83", `G1 E${fmtNum(signedLength)} F${speedMmMin}`, "M82"],
        };
    }
    // action === "move"
    const hasAbs = options.xMm !== undefined || options.yMm !== undefined;
    const hasRel = options.deltaXMm !== undefined || options.deltaYMm !== undefined;
    if (hasAbs && hasRel) {
        throw new Error("Provide either absolute (x_mm/y_mm) or relative (delta_x_mm/delta_y_mm) coordinates, not both.");
    }
    if (!hasAbs && !hasRel) {
        throw new Error("Toolhead move requires at least one of x_mm, y_mm, delta_x_mm, or delta_y_mm.");
    }
    const mode = options.mode ?? (hasAbs ? "absolute" : "relative");
    if (mode === "absolute" && !hasAbs)
        throw new Error("mode='absolute' requires x_mm and/or y_mm.");
    if (mode === "relative" && !hasRel)
        throw new Error("mode='relative' requires delta_x_mm and/or delta_y_mm.");
    const speedMmMin = options.speedMmMin === undefined
        ? TOOLHEAD_DEFAULT_SPEED_MM_MIN
        : Math.round(requireFinite("speed_mm_min", options.speedMmMin));
    if (speedMmMin < TOOLHEAD_MIN_SPEED_MM_MIN || speedMmMin > TOOLHEAD_MAX_SPEED_MM_MIN) {
        throw new Error(`speed_mm_min must be between ${TOOLHEAD_MIN_SPEED_MM_MIN} and ${TOOLHEAD_MAX_SPEED_MM_MIN} mm/min.`);
    }
    const tokens = ["G1"];
    if (mode === "absolute") {
        let xMm;
        let yMm;
        if (options.xMm !== undefined) {
            xMm = requireFinite("x_mm", options.xMm);
            if (xMm < 0 || xMm > maxXMm) {
                throw new Error(`${model} x_mm=${xMm} is outside the safe X limit [0, ${maxXMm}] mm.`);
            }
            tokens.push(`X${fmtNum(xMm)}`);
        }
        if (options.yMm !== undefined) {
            yMm = requireFinite("y_mm", options.yMm);
            if (yMm < 0 || yMm > maxYMm) {
                throw new Error(`${model} y_mm=${yMm} is outside the safe Y limit [0, ${maxYMm}] mm.`);
            }
            tokens.push(`Y${fmtNum(yMm)}`);
        }
        tokens.push(`F${speedMmMin}`);
        return {
            model,
            action,
            mode,
            target: { xMm, yMm },
            speedMmMin,
            requiresHotNozzle: false,
            gcodes: ["G90", tokens.join(" ")],
        };
    }
    let deltaXMm;
    let deltaYMm;
    if (options.deltaXMm !== undefined) {
        deltaXMm = requireFinite("delta_x_mm", options.deltaXMm);
        if (Math.abs(deltaXMm) > TOOLHEAD_MAX_RELATIVE_STEP_MM) {
            throw new Error(`delta_x_mm=${deltaXMm} exceeds the single-call relative step limit ±${TOOLHEAD_MAX_RELATIVE_STEP_MM} mm.`);
        }
        if (deltaXMm !== 0)
            tokens.push(`X${fmtNum(deltaXMm)}`);
    }
    if (options.deltaYMm !== undefined) {
        deltaYMm = requireFinite("delta_y_mm", options.deltaYMm);
        if (Math.abs(deltaYMm) > TOOLHEAD_MAX_RELATIVE_STEP_MM) {
            throw new Error(`delta_y_mm=${deltaYMm} exceeds the single-call relative step limit ±${TOOLHEAD_MAX_RELATIVE_STEP_MM} mm.`);
        }
        if (deltaYMm !== 0)
            tokens.push(`Y${fmtNum(deltaYMm)}`);
    }
    if (tokens.length === 1) {
        throw new Error("At least one of delta_x_mm or delta_y_mm must be non-zero.");
    }
    tokens.push(`F${speedMmMin}`);
    return {
        model,
        action,
        mode,
        target: { deltaXMm, deltaYMm },
        speedMmMin,
        requiresHotNozzle: false,
        gcodes: ["G91", tokens.join(" "), "G90"],
    };
}

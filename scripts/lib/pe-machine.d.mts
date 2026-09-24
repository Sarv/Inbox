/* Types for pe-machine.mjs — see userdata-dirs.d.mts for why these exist. */

/** Read the CPU architecture a Windows PE binary was compiled for. */
export declare function readPeMachine(buffer: Buffer): string;

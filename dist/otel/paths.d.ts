export declare function isValidSessionId(value: unknown): value is string;
export declare function getOtelDir(homeDir: string): string;
export declare function getSamplePath(homeDir: string, sessionId: string): string;
export declare function getPidFilePath(homeDir: string): string;
/**
 * Spawn-attempt bookkeeping for the receiver backoff. It sits beside the plugin
 * config rather than inside the sample directory on purpose: a sample directory
 * the receiver cannot write to is one of the failures the backoff exists for, so
 * the record must survive it.
 */
export declare function getSpawnStatePath(homeDir: string): string;
//# sourceMappingURL=paths.d.ts.map
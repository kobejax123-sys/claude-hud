import * as http from 'node:http';
/**
 * `Number(raw) || DEFAULT` would turn a valid 0 into the default and let a
 * negative through, and a negative retention prunes every sample the moment it is
 * written, so the rate could never accumulate.
 */
export declare function resolveRetentionDays(raw: string | undefined): number;
export interface StartReceiverOptions {
    homeDir: string;
    port: number;
    retentionDays: number;
    now?: () => number;
}
export declare function startReceiver(options: StartReceiverOptions): Promise<http.Server>;
//# sourceMappingURL=entry.d.ts.map
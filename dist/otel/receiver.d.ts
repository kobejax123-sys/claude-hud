/** OTLP export bodies are small log batches; anything larger is treated as hostile. */
export declare const MAX_BODY_BYTES = 1000000;
/**
 * Hard ceiling for one session's sample file. Age-based pruning cannot bound a
 * file that is still being written to — every append refreshes its mtime, so an
 * active session's file never falls into the retention window no matter how large
 * it grows. A session that is genuinely streaming produces on the order of 100 KB
 * per thousand requests, so anything near this ceiling is abnormal.
 */
export declare const MAX_SAMPLE_FILE_BYTES: number;
/**
 * Ceilings for the sample directory as a whole. The per-file cap alone does not
 * bound the directory: sample files can be created for any number of session ids,
 * and every one of them stays fresh — so age-based pruning never touches them.
 * The values are far above what real use produces (a session is on the order of
 * 100 KB per thousand requests).
 */
export declare const MAX_SAMPLE_FILES = 100;
export declare const MAX_SAMPLE_DIR_BYTES: number;
export interface ExtractedSample {
    sessionId: string;
    line: string;
}
export declare function extractSamples(payload: unknown): ExtractedSample[];
export declare function appendSamples(homeDir: string, samples: ExtractedSample[]): void;
export declare function pruneOldSamples(homeDir: string, retentionDays: number, now: number): void;
//# sourceMappingURL=receiver.d.ts.map
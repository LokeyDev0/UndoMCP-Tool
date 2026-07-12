/**
 * Checks if a file currently matches the expected hash.
 * Returns true if it matches, false if it differs or does not exist.
 */
export declare function verifyFileHash(filePath: string, expectedHash: string): boolean;
/**
 * Prompts the user to resolve a file conflict.
 * Option 1: Exit (abort rollback)
 * Option 2: Overwrite everything (revert to baseline snapshot)
 */
export declare function resolveConflictPrompt(filePath: string, messageDetail?: string): Promise<'exit' | 'overwrite'>;

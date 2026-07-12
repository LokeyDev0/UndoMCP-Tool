/**
 * DiffLine — Represents a single line in a diff result.
 */
export interface DiffLine {
    type: 'unchanged' | 'added' | 'removed';
    content: string;
}
/**
 * Computes the diff between two arrays of lines using the standard LCS algorithm.
 * Optimized with a safety limit for file size.
 */
export declare function diffLines(oldLines: string[], newLines: string[]): DiffLine[];
/**
 * Generates a clean unified diff string between old and new file content.
 */
export declare function generateUnifiedDiff(filePath: string, oldContent: string | null | undefined, newContent: string | null | undefined): string;

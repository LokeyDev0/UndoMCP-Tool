export interface ClientConfig {
    name: string;
    paths: string[];
}
export declare function setClientConfigsOverride(configs: ClientConfig[] | null): void;
export declare function getClientConfigs(): ClientConfig[];
/**
 * Detects which IDE configs actually exist on disk.
 * Returns a deduplicated list of { name, foundPath } entries.
 */
export declare function detectInstalledClients(): {
    name: string;
    foundPath: string;
}[];
/**
 * Interactive IDE selection TUI.
 * Shows detected IDEs with checkboxes and lets the user toggle selections.
 */
export declare function selectIdesInteractively(detectedClients: {
    name: string;
    foundPath: string;
}[]): Promise<{
    name: string;
    foundPath: string;
}[]>;
export interface SetupOptions {
    restore?: boolean;
    binaryPath?: string;
    /** Skip interactive selection — configure all detected IDEs (for CI and tests). */
    all?: boolean;
    /** Pre-selected client list — bypasses both detection and interactive selection (for programmatic use). */
    selectedClients?: {
        name: string;
        foundPath: string;
    }[];
}
export declare function runSetup(options?: SetupOptions): Promise<void>;

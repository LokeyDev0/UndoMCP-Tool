export interface UninstallOptions {
    keepDb?: boolean;
    all?: boolean;
}
export declare function runUninstall(options: UninstallOptions): Promise<void>;

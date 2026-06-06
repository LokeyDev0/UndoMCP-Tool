export interface ClientConfig {
    name: string;
    paths: string[];
}
export declare function setClientConfigsOverride(configs: ClientConfig[] | null): void;
export declare function getClientConfigs(): ClientConfig[];
export declare function runSetup(options: {
    restore?: boolean;
    binaryPath?: string;
}): Promise<void>;

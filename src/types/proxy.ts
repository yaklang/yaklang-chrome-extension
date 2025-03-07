export interface PacScript {
    data?: string;
    url?: string;
    mandatory?: boolean;
}

export interface ProxyConfig {
    id: string;
    name: string;
    enabled: boolean;
    proxyType: "direct" | "system" | "fixed_servers" | "pac_script" | "auto_detect";
    mode?: string;
    host?: string;
    port?: number;
    scheme?: "http" | "https" | "socks4" | "socks5";
    pacScript?: PacScript;
    bypassList?: string[];    
    matchList?: string[];
}

export interface ProxyLog {
    id: string;
    timestamp: number;
    url: string;
    proxyId: string;
    proxyName: string;
    status: 'success' | 'error';
    errorMessage?: string;
    method?: string;
    requestHeaders?: Record<string, string>;
    requestBody?: string;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    timing?: {
        startTime: number;
        endTime: number;
        duration: number;
    };
    protocol?: string;
    ip?: string;
    fromCache?: boolean;
    host?: string;
    port?: number;
    resourceType?: 'xhr' | 'fetch' | 'script' | 'stylesheet' | 'image' | 'other';
} 
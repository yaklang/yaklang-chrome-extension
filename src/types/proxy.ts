export interface ProxyConfig {
    id: string;
    name: string;
    enabled: boolean;
    proxyType: "direct" | "fixed_server" | "pac_script" | "auto_detect" | "bypass_list";
    host?: string;
    port?: number;
    scheme?: "http" | "https" | "socks4" | "socks5";
    pacScript?: string;
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
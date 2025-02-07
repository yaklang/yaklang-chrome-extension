export interface ProxyConfig {
    id: string;
    name: string;
    enabled: boolean;
    proxyType: "direct" | "fixed_server" | "pac_script" | "auto_detect" | "bypass_list";
    host?: string;
    port?: number;
    scheme?: "http" | "https" | "socks4" | "socks5";
    pacScript?: string;
    bypassList?: string[];
} 
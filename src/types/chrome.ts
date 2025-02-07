export interface StorageChange<T = any> {
    oldValue?: T;
    newValue?: T;
}

export interface StorageChanges {
    [key: string]: StorageChange;
}

export interface ProxyConfig {
    host: string;
    port: number;
    scheme: 'http' | 'https' | 'socks5';
    proxyType: 'fixed_server';
    enabled?: boolean;
    id?: string;
    name?: string;
    timestamp?: number;
} 
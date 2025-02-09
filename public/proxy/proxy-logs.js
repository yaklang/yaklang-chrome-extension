// 日志数据库管理
export class ProxyLogs {
    static DB_NAME = 'yakit_proxy_logs';
    static STORE_NAME = 'logs';
    static VERSION = 1;

    static async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                    // 创建索引
                    store.createIndex('timestamp', 'timestamp');
                    store.createIndex('url', 'url');
                    store.createIndex('proxyId', 'proxyId');
                    store.createIndex('status', 'status');
                }
            };
        });
    }

    static async addLog(log) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([this.STORE_NAME], 'readwrite');
            const store = transaction.objectStore(this.STORE_NAME);

            // 添加新日志
            const request = store.add(log);

            request.onsuccess = () => {
                // 删除旧日志，只保留最新的 100 条
                const countRequest = store.count();
                countRequest.onsuccess = () => {
                    if (countRequest.result > 100) {
                        const index = store.index('timestamp');
                        const cursorRequest = index.openCursor();
                        let deleteCount = countRequest.result - 100;

                        cursorRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor && deleteCount > 0) {
                                store.delete(cursor.primaryKey);
                                deleteCount--;
                                cursor.continue();
                            }
                        };
                    }
                };
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    static async getLogs(limit = 100) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([this.STORE_NAME], 'readonly');
            const store = transaction.objectStore(this.STORE_NAME);
            const index = store.index('timestamp');
            
            const request = index.openCursor(null, 'prev');
            const logs = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && logs.length < limit) {
                    logs.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(logs);
                }
            };

            request.onerror = () => reject(request.error);
        });
    }

    static async clearLogs() {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([this.STORE_NAME], 'readwrite');
            const store = transaction.objectStore(this.STORE_NAME);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
} 
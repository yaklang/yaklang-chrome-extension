declare namespace chrome.storage {
    interface StorageChange {
        oldValue?: any;
        newValue?: any;
    }

    type StorageChanges = {
        [key: string]: StorageChange;
    };
} 
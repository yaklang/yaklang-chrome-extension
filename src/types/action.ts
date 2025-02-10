// export const ActionType = {
//     CONNECT: "CONNECT",
//     SEND_MESSAGE: "SEND_MESSAGE",
//     DISCONNECT: "DISCONNECT",
//     SET_PROXY: "SET_PROXY",
//     CLEAR_PROXY: "CLEAR_PROXY",
//     PROXY_STATUS: "PROXY_STATUS",
//     INJECT_SCRIPT: "INJECT_SCRIPT"
// } as const;

// export type ActionType = typeof ActionType[keyof typeof ActionType];

export const ProxyActionType = {
    SET_PROXY_CONFIG: "SET_PROXY_CONFIG",
    CLEAR_PROXY_CONFIG: "CLEAR_PROXY_CONFIG",
    GET_PROXY_STATUS: "GET_PROXY_STATUS",
    CLEAR_PROXY_LOGS: "CLEAR_PROXY_LOGS",
    GET_PROXY_LOGS: "GET_PROXY_LOGS",
    GET_PROXY_CONFIGS: "GET_PROXY_CONFIGS",
    ADD_PROXY_CONFIG: "ADD_PROXY_CONFIG",
    UPDATE_PROXY_CONFIG: "UPDATE_PROXY_CONFIG"
} as const;

export type ProxyActionType = typeof ProxyActionType[keyof typeof ProxyActionType]; 
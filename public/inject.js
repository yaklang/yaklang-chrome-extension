console.log('This runs at document start, before any document content is parsed.');
// 保存原始的console.log函数的引用
const originalConsoleLog = console.log;

// 重写console.log
console.log = function (message) {
    // 调用原始的console.log函数
    originalConsoleLog("trying to open " + message + " window.");
};

window.open = function (url) {
    console.log("trying to open " + url + " window.");
}
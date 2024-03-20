const path = require('path');

module.exports = {
    mode: 'development', // 设置模式为开发模式
    entry: './src/index.jsx', // 指定入口文件
    output: {
        path: path.resolve(__dirname, 'dist'), // 输出目录
        filename: 'bundle.js', // 输出文件名
    },
    watch: true, // 开启实时监控
    module: {
        rules: [
            {
                test: /\.css$/, // 匹配所有的 css 文件
                use: ['style-loader', 'css-loader'] // 对匹配到的文件使用这两个 loader
            },
            {
                test: /\.(js|jsx)$/, // 匹配JS和JSX文件
                exclude: /node_modules/, // 排除node_modules目录
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env', '@babel/preset-react'] // 使用的babel预设
                    }
                }
            }
        ]
    },
    resolve: {
        extensions: ['.js', '.jsx'] // 解析扩展（确保能够解析JS和JSX文件）
    },
    devtool: 'inline-source-map', // 生成内联源映射，便于调试
};

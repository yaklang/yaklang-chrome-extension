require('dotenv').config();
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  mode: 'development', // 设置模式为开发模式
  entry: {
    main: './src/index.jsx',
    options: './src/pages/options.tsx'
  },
  output: {
    path: path.resolve(__dirname, 'build'), // 输出目录
    filename: '[name].bundle.js', // 输出文件名
    publicPath: '/',
    clean: true
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
      'process.env.BABEL_ENV': JSON.stringify(process.env.BABEL_ENV || 'development'),
    }),
    new HtmlWebpackPlugin({
      template: './public/index.html',
      filename: 'index.html',
      chunks: ['main']
    }),
    new HtmlWebpackPlugin({
      template: './public/proxy/options.html',
      filename: 'proxy/options.html',
      chunks: ['options'],
      publicPath: '../'
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'public'),
          to: path.resolve(__dirname, 'build'),
          globOptions: {
            ignore: ['**/index.html', '**/proxy/options.html']
          }
        }
      ]
    })
  ],
  watch: true, // 开启实时监控
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.tsx?$/, // 匹配TS和TSX文件
        use: 'ts-loader',
        exclude: /node_modules/,
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
    extensions: ['.tsx', '.ts', '.js', '.jsx'], // 解析扩展（确保能够解析JS和JSX文件）
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@assets': path.resolve(__dirname, './src/assets'),
      '@components': path.resolve(__dirname, './src/components'),
      '@network': path.resolve(__dirname, './src/network'),
      '@types': path.resolve(__dirname, './src/types'),
    }
  },
  devtool: 'inline-source-map', // 生成内联源映射，便于调试
};
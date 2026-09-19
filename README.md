# Fitness Food Proxy

微信云托管饮食识别服务。小程序先将图片上传到微信云存储，服务端读取临时地址并调用豆包视觉模型，返回结构化菜品和营养估算。

## 云托管部署

1. 将本目录作为独立 Git 仓库推送。
2. 在微信云托管创建服务，并选择该 Git 仓库和 Dockerfile 构建。
3. 在服务环境变量中配置：

   - `DOUBAO_API_KEY`：豆包 API Key
   - `DOUBAO_ENDPOINT_ID`：豆包推理接入点 ID
   - `FOOD_PROXY_AUTH_MODE=cloudbase`

   不要把真实值写入代码、`.env` 或 Git。云托管发布设置中的容器端口填写 `80`。

4. 部署后访问 `GET /health`，应返回 `{"ok":true}`。
5. 小程序应通过 `wx.cloud.callContainer` 调用 `POST /food/analyze`，服务名由云托管控制台确定。

## 请求

`POST /food/analyze`，请求体只传微信云存储生成的临时 HTTPS 地址，避免 `callContainer` 的 100KB 请求体限制：

```json
{"imageUrl":"https://example.tcb.qcloud.la/food.jpg?token=temporary"}
```

云托管模式要求平台注入有效的 `X-WX-OPENID` 和 `X-WX-APPID`。不要从普通公网客户端手工添加这些请求头。服务端仅允许微信云存储和 COS 域名。

## 本地检查

```powershell
npm run check
$env:NODE_ENV='production'
$env:PORT='8080'
$env:DOUBAO_API_KEY='仅本地临时值'
$env:DOUBAO_ENDPOINT_ID='仅本地临时值'
$env:FOOD_PROXY_AUTH_MODE='cloudbase'
npm start
```

健康检查：

```text
http://127.0.0.1:8080/health
```

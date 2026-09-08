# Embedding 模型配置与 Gemini Embedding 2

核对日期：2026-09-08。价格是上游公开原价，不是 PaperChat 对用户的计费价格。

## PaperChat 配置

在 API 子模块的 `model-routing.json` 中新增独立对象（保留已有聊天 `models` 和 `defaults`）：

```json
{
  "embedding": {
    "models": ["text-embedding-v4", "gemini-embedding-2"],
    "defaultModel": "text-embedding-v4"
  }
}
```

可以在 API 管理页面的 Embedding 模型表单或高级 JSON 中编辑。`defaultModel` 必须在 `models` 内；插件只选择同时出现在账号可用模型列表中的模型。默认模型不可用时回退到其余可用模型。省略该对象沿用旧版自动识别规则，空列表关闭 PaperChat 的 embedding 候选，但仍可能使用其他已配置 provider。服务端和客户端更新并拉取配置后生效；仅修改示例文件不会部署配置。配置模型名称也不会自动为上游添加模型或账号权限。

PaperChat 继续调用 OpenAI 兼容 `/embeddings`，每批最多 10 条，输出维度 1024。上游需支持所配置模型及 `dimensions` 参数。

## 向量保存与模型切换

论文向量的现有逻辑保持不变。长期记忆数据库升级至 v17，新增 `memory_embeddings`，以 `(memory_id, model_id)` 为主键。旧向量迁移至新表，原记忆文本保留。

切换模型时不再清空旧向量：查询只匹配当前模型，并检查维度；缺失向量在后台批量补齐，期间仍能用文本检索；切回旧模型直接复用。模型标识含 provider 前缀，因此 PaperChat 和原生 Gemini 不混用。记忆删除或文本变化会移除其所有旧向量，异步回写必须匹配仍存在的原文本。

## Gemini 的同步批量调用

原生 Gemini provider 使用稳定版 `gemini-embedding-2`，保持 768 维（显式设置 `outputDimensionality`），同步 `batchEmbedContents`，客户端每批最多 100 条。返回数量和维度不正确时拒绝写入。

```http
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents
x-goog-api-key: YOUR_API_KEY
Content-Type: application/json
```

```json
{
  "requests": [
    {
      "model": "models/gemini-embedding-2",
      "outputDimensionality": 768,
      "content": { "parts": [{ "text": "第一段论文文本" }] }
    },
    {
      "model": "models/gemini-embedding-2",
      "outputDimensionality": 768,
      "content": { "parts": [{ "text": "第二段论文文本" }] }
    }
  ]
}
```

每段文本用独立 request；把多个片段塞入同一个 content 可能得到聚合后的一个向量。模型输入上限 8192 tokens，默认 3072 维，可调 128–3072，官方建议 768/1536/3072。插件仍沿用保守的 8192 字符输入截断。Embedding 2 不接受 `taskType`；官方建议用文本前缀表达检索任务。本次保持原有文本输入，避免引入额外检索语义变更。

## 异步 Batch（未来离线建库）

同步批量请求不享受 Batch 折扣。Google 的半价 Batch 是异步任务，目标周转时间为 24 小时，适合大量论文预建索引，不适合等待即时答案的查询向量。

官方 Google Gen AI SDK 的入口为 `client.batches.create_embeddings`（Python）或 `client.batches.createEmbeddings`（JavaScript），传入 `model="gemini-embedding-2"`，`src` 支持内联请求或已上传文件。例如已上传请求文件后：

```python
job = client.batches.create_embeddings(
    model="gemini-embedding-2",
    src={"file_name": uploaded_batch_requests.name},
    config={"display_name": "paper embeddings"},
)
```

之后查询任务状态，完成后读取输出；需要处理单条失败及结果与原文的对应关系。插件本次未加入离线任务提交、轮询和恢复系统，保留即时检索需要的同步批量方式。

## 文本价格（每百万输入 tokens）

| 模型/地域                                | 标准请求（含同步批量） | 异步 Batch         |
| ---------------------------------------- | ---------------------- | ------------------ |
| Google Gemini Embedding 2                | US$0.20                | US$0.10            |
| 阿里云 text-embedding-v4，华北 2（北京） | ¥0.50                  | ¥0.25              |
| 阿里云 text-embedding-v4，新加坡国际部署 | ¥0.514                 | 该模型页标注不支持 |

仅为量级比较，若假设 US$1 = ¥7，Google 对应 ¥1.40 / ¥0.70，约为阿里云北京价格的 2.8 倍；该汇率不是实时报价。不同 tokenizer 会影响相同文档的实际计费 token 数。两者的质量需用真实论文检索任务评估，价格无法替代效果评测。

## 官方来源

- [Gemini Embedding 2 模型](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2)
- [Gemini embedding 使用指南](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini embedding REST API](https://ai.google.dev/api/embeddings)
- [Google Batch API（含 embedding 示例）](https://ai.google.dev/gemini-api/docs/batch-api)
- [Google 定价](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding-2)
- [阿里云 text-embedding-v4 地域能力及价格](https://help.aliyun.com/zh/model-studio/text-embedding-v4)
- [阿里云 OpenAI 兼容 embedding 接口](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai)

# 划词翻译上下文方案调研

调研日期：2026-09-08。以下是源码或官方 API 文档中可确认的行为，不代表这些项目在同一语料上的效果对比。

## 参考实现

### Zotero PDF Translate

`transformPromptWithContext()` 在 `attachPaperContext` 打开、且有 itemId 时，取顶层条目的 title 和 abstractNote，作为 Paper Title / Paper Abstract，放在 Text to translate 前面。该开关默认关闭。这段实现没有固定截取选区前后文，也没有对摘要设置长度上限。

可以借鉴论文元数据辅助领域消歧；对于即时划词翻译，不必每次附上整篇摘要。

- [上下文组装源码](https://github.com/windingwind/zotero-pdf-translate/blob/eae077e0829f93dbc6851ce467173716b4c28df8/src/utils/llmPrompt.ts#L13)
- [默认配置和提示词](https://github.com/windingwind/zotero-pdf-translate/blob/eae077e0829f93dbc6851ce467173716b4c28df8/addon/prefs.js#L3)

### OpenAI Translator

`selectedWord` 模式把完整的 `query.text` 和目标单词 `selectedWord` 分别传给模型，要求解释单词在语境中的含义和惯用表达。提示词将输入称为句子，但代码没有自动提取单句或在此限制上下文长度。它是单词解释模式，会输出示例等内容；不能把它描述为所有翻译请求都会自动读取浏览器邻近段落。

可借鉴“目标 + 所在语境”的清晰分离；我们的段落翻译不需要引入词典解释和例句。

- [选词模式及提示词](https://github.com/openai-translator/openai-translator/blob/a9681a4ab0599bef7013e29fca701f250d7738a2/src/common/translate.ts#L346)

### llm-for-zotero

这次查看的是选区问答的上下文组装，不是专用翻译接口。它把选区、来源、论文归属、附件和页码等定位信息分开组织；可附加解析后的本地来源上下文，指导模型在需要更多信息时读取对应页及邻页。

单个选区来源上下文最多 6,500 字符，多个合计最多 12,000 字符（包含格式标签等开销）。这些是问答的上限，不是通常实际长度，也不是前后各自的翻译预算。

可借鉴把上下文绑定到具体选区和来源，避免相同文字定位到另一个出现位置。其检索/页级扩展流程服务于复杂问答，当前即时翻译无需照搬。

- [选区上下文组装](https://github.com/yilewang/llm-for-zotero/blob/5be02f51a9bdf9b143439c95eed07bd62a34cb68/src/modules/contextPanel/textUtils.ts#L166)
- [上下文长度预算](https://github.com/yilewang/llm-for-zotero/blob/5be02f51a9bdf9b143439c95eed07bd62a34cb68/src/modules/contextPanel/selectedTextAnchors.ts#L21)
- [本地来源上下文及定位信息](https://github.com/yilewang/llm-for-zotero/blob/5be02f51a9bdf9b143439c95eed07bd62a34cb68/src/modules/contextPanel/selectedTextAnchorFormatting.ts#L49)

### DeepL API

官方 `context` 字段用于影响译义，但自身不翻译；文档说明此字段的字符不计入 DeepL 字符计费。这是 DeepL 的 API 规则，不适用于我们调用的通用 LLM：上下文仍会占用输入 tokens。

- [Translate API：context 字段](https://developers.deepl.com/api-reference/translate#body-context)

## 对本插件的建议与当前状态

采用论文标题（最多 300 字符）+ 原始选区 + 前后各最多 200 字符。

- `selectedText` 与 `referenceContext` 明确分开，只输出 selectedText 的译文。
- 上下文按实际 DOM Range 提取，并在显示选区入口时保存；选区不匹配或 textLayer 不可用时省略邻近文本。
- 目前仅从选区起止所在的 PDF textLayer 取相邻文本，不检索全文、不发送整篇摘要或聊天历史。
- 缓存纳入上下文；同一选区出现在不同论文或不同上下文时不混用译文。
- 200 是本产品的预算选择，不是调研得到的行业标准或已验证的最佳长度。
- PDF DOM 顺序可能受多栏版式影响，固定字符截断也可能截断英文单词；这些是下一步真实论文效果对比时需要关注的点。当前先不引入复杂的版面分析或二次模型请求。

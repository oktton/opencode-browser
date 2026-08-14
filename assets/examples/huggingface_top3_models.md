# Hugging Face 热门大语言模型 Top 3

> 数据来源：[Hugging Face Models - Trending (Text Generation)](https://huggingface.co/models?pipeline_tag=text-generation&sort=trending)
> 采集时间：2026-08-13

## 榜单概览

| 排名 | 模型名称 | 发布机构 | 参数规模 | 月下载量 | 点赞数 | 是否支持中文 |
|------|----------|----------|----------|----------|--------|--------------|
| 1 | Qwen/Qwen3.8-2.4T-A95B | 阿里巴巴（Qwen） | 2.4T (MoE) | 1,012 | 694 | ✅ 支持 |
| 2 | deepseek-ai/DeepSeek-V4-Flash-0731 | DeepSeek | 304B | 1,431,587 | 3.29k | ✅ 支持 |
| 3 | LiquidAI/LFM2.5-2.6B | Liquid AI | 3B | 116,640 | 596 | ✅ 支持（16种语言） |

---

## 详细说明

### 1. Qwen/Qwen3.8-2.4T-A95B

- **发布机构**：阿里巴巴 Qwen 团队
- **参数规模**：2.4T（采用 MoE 架构，激活参数量 A95B）
- **热度指标**：
  - 月下载量：1,012
  - 点赞数：694
  - 更新于：1 天前
- **中文支持**：✅ 是（Qwen 系列原生支持中文，定位多语言大模型）
- **模型地址**：https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B

### 2. deepseek-ai/DeepSeek-V4-Flash-0731

- **发布机构**：深度求索（DeepSeek）
- **参数规模**：304B
- **热度指标**：
  - 月下载量：1,431,587
  - 点赞数：3,290
  - 更新于：12 天前
- **中文支持**：✅ 是（DeepSeek 是国内 AI 公司，模型原生支持中文）
- **许可证**：MIT
- **模型地址**：https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731

### 3. LiquidAI/LFM2.5-2.6B

- **发布机构**：Liquid AI
- **参数规模**：3B
- **热度指标**：
  - 月下载量：116,640
  - 点赞数：596
  - 更新于：6 天前
- **中文支持**：✅ 是（支持 16 种语言，包括中文、英文、阿拉伯语、法语、德语、日语、韩语、俄语、西班牙语等）
- **许可证**：lfm1.0
- **特点**：混合架构，128K 上下文，针对端侧部署优化（Apple M5 Max 上 220 tok/s，AMD Ryzen CPU 上 113 tok/s）
- **论文**：arxiv: 2511.23404
- **模型地址**：https://huggingface.co/LiquidAI/LFM2.5-2.6B

---

## 备注

- 排行基于 Hugging Face 平台 **Trending（趋势热度）** 排序，而非单纯下载量。
- 三款模型均支持中文，反映出中文大模型生态在开源社区的活跃度。
- Qwen 和 DeepSeek 为中国机构发布，Liquid AI 为美国公司但同样提供中文支持。

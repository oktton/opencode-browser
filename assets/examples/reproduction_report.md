# 论文代码复现调查报告

**论文**：Generative Agents: Interactive Simulacra of Human Behavior
**作者**：Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, Michael S. Bernstein
**会议/年份**：UIST 2023（arXiv:2304.03442）
**调研日期**：2026-08-13

---

## 1. GitHub 仓库信息

| 项目 | 信息 |
| --- | --- |
| 官方仓库 | [`joonspk-research/generative_agents`](https://github.com/joonspk-research/generative_agents) |
| Stars / Forks | 21.9k / 3.1k |
| 许可证 | Apache-2.0 |
| 主分支提交数 | 31 |
| 贡献者 | 5（核心作者团队） |
| Open / Closed Issues | 115 / 29 |
| Open Pull Requests | 31 |
| 最后一次提交 | 2023 年（main 分支当前 HEAD 距今约 3 年未更新） |

**相关/衍生仓库**（在 GitHub 搜索结果中出现）：

- `mkturkcan/generative-agents`（994★，2025-01，**local 低成本复刻版**，不依赖完整 GPT-4）
- `nmatter1/smallville`（813★，Java 实现 + 视频游戏可视化）
- `QuangBK/generativeAgent_LLM`（287★，Jupyter Notebook 复现）
- `ayoreis/generative-agents`（92★，Python 归档）
- `www-Ye/generative_agents_chinese`（87★，中文版）
- `grahamhome/llm-ant-farm`（58★）
- `horenbergerb/llamagotchi`（22★）

---

## 2. 代码与资源完整性

### 2.1 仓库目录结构

```
generative_agents/
├── environment/frontend_server/     # Django 前端可视化界面
├── reverie/                         # 后端代理核心逻辑
├── .gitattributes
├── .gitignore
├── LICENSE                          # Apache-2.0
├── README.md                        # 详细安装与运行步骤
├── cover.png
└── requirements.txt                 # Python 依赖
```

### 2.2 各项检查

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 完整代码 | ✅ 已提供 | `environment/`（前端 Django 服务器）+ `reverie/`（后端代理逻辑）两个模块完整 |
| 依赖清单 | ✅ 已提供 | `requirements.txt` 明确锁定版本 |
| 运行说明 | ✅ 详细 | README 含 Setup → Run Simulator → Interact 三段式逐步教程 |
| 数据/示例 | ✅ 已提供 | 内置 `base_the_ville_n25.csv`（25 agents）与 `base_the_ville_isabella_maria_klaus.csv`（3 agents）初始记忆；预压缩 demo 存储于 `environment/frontend_server/compressed_storage` |
| 额外 API 必需 | ⚠️ 需要 OpenAI API | 必须在 `reverie/backend_server/` 下自建 `utils.py`，写入有效的 `openai_api_key` |
| 模型 | ⚠️ 原版依赖已下架模型 | 默认使用 `text-davinci-002` / `text-davinci-003`（**OpenAI 已停止服务**，见第 4 节） |

---

## 3. 运行环境要求

### 3.1 Python 依赖（`requirements.txt`，已锁定版本）

关键依赖：

- `openai==0.27.0`（**2023 年的旧版 API 客户端**，与当前 1.x 客户端调用方式不兼容）
- `nltk==3.6.5`
- `numpy==1.25.2`
- `pandas==2.0.3`
- `scikit-learn==1.3.0`
- `scipy==1.11.1`
- `Pillow==8.4.0`
- `selenium==4.8.2`
- `gensim`（无显式版本，问题 issue #94 报告 **`gensim` 无法在现代 Python 上编译**）
- 此外前端使用 Django、`sqlparse==0.4.4` 等

### 3.2 启动流程（README 摘要）

1. `git clone` 仓库，创建并激活 Python 虚拟环境
2. `pip install -r requirements.txt`
3. 在 `reverie/backend_server/` 创建 `utils.py`，填入 `openai_api_key` 与 `key_openai`
4. 启动前端服务器：`cd environment/frontend_server && python manage.py runserver`
5. 启动后端代理：`cd reverie/backend_server && python reverie.py`
6. 在控制台依次输入命令：`fork_sim` → `run 1` → 浏览器访问 `http://localhost:8000/demo/<sim_name>-step-<X>-<Y>/<A>/<B>/`

---

## 4. 仓库活跃度与已知 Issues

### 4.1 更新频率

- **main 分支最新提交时间约为 2023 年**，距今已 ~3 年未更新
- 标记为 "Readme updated" 的最后一次提交明显早于 2024 年
- 仍存在 115 个未关闭的 issue 与 31 个 open PR，**作者团队几乎不再维护**

### 4.2 Issues 中高频复现问题

| 问题类别 | 代表 issue | 说明 |
| --- | --- | --- |
| 模型被 OpenAI 弃用 | #133 | `text-davinci-002`、`text-davinci-003` 已下架，无直接替代品，需自行改写 prompt 并切换至 `gpt-3.5-turbo-instruct` 或 `gpt-4` |
| 模型兼容性 | #146, 多个 open issue | 社区反复询问 "能否用 GPT-4-turbo / GPT-4o / Gemini / DeepSeek 等"，原代码未适配 |
| 依赖安装失败 | #94（11 条评论） | `gensim` 在现代 Python 上 wheel 编译失败，直接 `pip install -r requirements.txt` 会卡住 |
| Token limit | #177（10 条评论） | `run 1` 时频繁触发 OpenAI 速率/令牌上限，长 context 极易超限 |
| UI 静态/卡死 | #136, #134, #177 | 前端无法渲染动作、显示静态画面、时间不变化 |
| 代理停滞不动 | #177 等多 issue | "Stuck after run 1 step"，agents 站着不动 |
| 内存泄漏 | #137 | 前端长时间运行后内存持续上涨 |
| 操作步骤遗漏 | 多 issue 报告 | 未先执行 `fork_sim` 直接 `run 1`，导致后续全部报错 |
| 项目维护停滞 | #129, #177 | 用户直接询问"项目作者是否还在维护？是否还能运行？" |

### 4.3 维护活跃度判断

- 当前 HEAD 提交已是 3 年前
- 截至本次调研，**仍有人持续提 issue**，且大部分未得到响应
- 衍生仓库（如 `mkturkcan/generative-agents`）反而更活跃，是想跑通该项目的更佳备选

---

## 5. 复现难度评估

### 结论：🟡 **中等（中等偏难）**

代码公开完整、结构清晰、样例齐全，理论上可在数小时内跑通 demo；但在 2026 年的实际环境下面临若干必须解决的工程问题。

### 难度判断的主要依据

| 维度 | 评估 |
| --- | --- |
| 代码完整度 | ⭐⭐⭐⭐⭐ 全量源码 + 配置 + README 齐全 |
| 安装便利度 | ⭐⭐ Python 依赖可装，但 **gensim 编译失败**、openai 0.27.0 与新版本冲突需要降版本处理 |
| 模型可用性 | ⭐⭐ **关键瓶颈**：原模型已下架，需迁移至 GPT-3.5/4 系列并修改调用代码与 prompt |
| 算力/成本 | ⭐⭐ 单次运行涉及数十次 LLM 调用且 token 消耗巨大，作者明确警告"运行成本不菲" |
| 运维支持 | ⭐ 项目 3 年未更新，issue 长期无人响应，遇到问题大多要靠自己排查 |
| 可视化与交互 | ⭐⭐ 多人报告地图静态不动、代理卡死，复现完 demo 后还需调试前端 |
| 文档完整度 | ⭐⭐⭐⭐⭐ README 步骤非常详细，作者本身鼓励用户复现 |

### 主要原因（按重要性排序）

1. **核心模型被 OpenAI 弃用**：`text-davinci-002 / 003` 已不可用，必须修改 `reverie.py` 与相关 prompt，改用 `gpt-3.5-turbo`/`gpt-4` 等 chat 模型，工作量可观。
2. **环境老旧**：Python 依赖锁定在 2023 版本，`gensim` 等包在新环境下需要手动兼容（issue #94 有详细 workaround 讨论）。
3. **API 成本与速率限制**：复现一次完整的 25 人小镇 demo 需大量调用，作者明确提示成本较高，需要稳定可用的 OpenAI 账户与额度。
4. **项目接近停更**：大量 issue 无法得到官方回复，问题排查依赖社区。
5. **必须先 fork_sim 后 run**：README 步骤隐含，若漏掉 `fork_sim` 直接 `run 1` 会出现 KeyError，导致新手误以为是环境问题。

---

## 6. 复现建议

1. **优先使用衍生仓库作为起点**：`mkturkcan/generative-agents`（低成本本地版）或 `QuangBK/generativeAgent_LLM`（Jupyter 演示）对新手更友好，能避免原仓库的依赖陷阱。
2. **若坚持复现原仓库**：
   - 使用 Python 3.10 左右的虚拟环境，避免新版 Python 与 `gensim`、`numpy 1.25` 等冲突
   - 将 `openai==0.27.0` 升级到 1.x 后，**按 OpenAI 迁移指南**重写 `reverie.py` 中所有 chat completion 调用
   - 把 `text-davinci-*` 全部替换成 `gpt-3.5-turbo-instruct` 或 `gpt-4o-mini`，并相应调整 prompt
   - 预先在 `reverie/backend_server/` 中写好 `utils.py`
   - 严格按 README 顺序执行：先 `fork_sim` → 再 `run 1`
   - 若使用 GPT-4 系列，注意 token 限额与价格，**预算需 5–20 美元**才能跑完一个完整 demo
3. **若仅做学术研究/可视化对比**：直接读 README + 论文即可，原仓库 demo 仅作为演示，不必完整复现 25 个 agent。

---

## 7. 一句话总结

> 项目公开完整、文档详细，但因为核心 OpenAI 模型已下线、依赖年久失修、API 调用昂贵、作者不再维护，**复现难度为中等**——花足够时间可在 1–2 天内跑通修改版，但需要主动适配代码、处理 token 与速率问题。

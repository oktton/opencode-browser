# LBS Contact Form 填写报告

- **目标页面**：https://www.london.edu/about/contact
- **表单名称**：`C44_ContactUsForm`
- **填写时间**：访问 LBS Contact Us 页面后
- **页面提示**："All fields are required."（页面明确标注所有字段均为必填项）
- **Comment 字段提示**："Comment or enquiry details (max 140 characters)"（最多 140 字符）

## 一、表单字段填写情况

| 字段标签 | 字段 ID | 填写值 | 是否成功 |
| --- | --- | --- | --- |
| What's your question about? | `Question` | `Masters programmes` | ✅ |
| Topic? | `topic` | `Unspecified` | ✅（选择 "Masters programmes" 后才显示） |
| Email | `emailAddress` | `kai.chen@example.com` | ✅ |
| Title | `title` | `Mr` | ✅ |
| First Name | `firstName` | `Kai` | ✅ |
| Last Name | `lastName` | `Chen` | ✅ |
| Comment or enquiry details | `objectivesText` | `I would like to know more about the application requirements for your master's programmes.`（90 字符） | ✅ |
| Password | `password` | `KaiMaster2026`（13 字符，含大小写字母+数字） | ✅ |
| Confirm password | `confirmPassword` | `KaiMaster2026`（与密码一致） | ✅ |

## 二、字段 DOM 约束检查

通过 `Element.validity` / `attributes` 拉取的每个字段的实际约束如下：

| 字段 | required | minLength | maxLength | pattern | validity.valid | validationMessage |
| --- | --- | --- | --- | --- | --- | --- |
| emailAddress | false | -1 | -1 | — | true | （空） |
| firstName | false | -1 | -1 | — | true | （空） |
| lastName | false | -1 | -1 | — | true | （空） |
| title | false | — | — | — | true | （空） |
| topic | false | — | — | — | true | （空） |
| objectivesText | false | -1 | -1（仅 UI 提示 140 字符上限） | — | true | （空） |
| password | false | -1 | -1 | — | true | （空） |
| confirmPassword | false | -1 | -1 | — | true | （空） |

注意：所有字段在 HTML 属性层面都没有 `required`、`minLength`、`maxLength` 或 `pattern` 约束；"必填" 和 "140 字符上限" 主要是 UI 文本提示与后端校验，而不是浏览器原生 `validity` 校验。

## 三、页面校验提示结果

- **必填项提示**：页面顶部声明 "All fields are required."，但选择/输入完成后没有任何字段在 UI 上弹出错错（无红色边框、无错误文字、`<aria-invalid>` 全为 `false`）。
- **密码格式提示**：没有客户端提示（无 minLength、pattern 提示文字）。`KaiMaster2026`（13 字符，含大小写字母 + 数字）通过了 `validity.valid` 检查。表单未声明具体的密码复杂度规则。
- **字符长度提示**：Comment 字段标注 "max 140 characters"；本次填写 90 字符，远低于上限，未触发任何超长提示。
- **密码一致性**：前端并未自动弹出"密码不匹配"提示，但在脚本中确认 `password === confirmPassword`。
- **`role="alert"` / 错误容器扫描**：仅发现一个空的 `<p role="alert">`，无任何错误文字。
- **Submit 按钮状态**：`#submitButton` 文字为 `Submit`，`disabled = false`，`className` 为 `SubmitButton_flex__V1Qto  cta regular`，处于可点击状态。

## 四、是否可正常进入"提交前"状态

✅ **可以正常进入提交前状态**。完成所有 9 个字段填写后：

- 页面没有出现任何红色错误提示或弹窗；
- 所有字段 `validity.valid === true`；
- Submit 按钮处于启用（可点击）状态；
- 表单没有阻止继续操作。

按用户要求，**未点击 Submit 按钮**，未真正提交表单。

## 五、注意事项

1. "Topic?" 字段在选择 "Masters programmes" 之前是隐藏的，单纯打开页面时不可见——填写时需要先选 Question，再选 Topic。
2. 提交按钮的实际服务端校验（邮箱域名黑名单、密码强度、字符长度等）需要真正提交才会触发，本次未做该步骤。
3. 邮箱字段 `id` 不是 `email` 而是 `emailAddress`，使用 `querySelector` 时需注意。

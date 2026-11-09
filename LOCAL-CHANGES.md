# 本地变更记录（`mine` 分支）

`mine` 是本地维护分支，用来承载暂时不打算上游化的改动。向上游提 PR 时用独立的 `feat/*` 分支，**不要把这个文件带进去**。

## 基线

| 项 | 值 |
|---|---|
| 上游仓库 | `github.com/YuGiMob/pi-hashline-edit-pro`（见 `package.json` 的 `repository`） |
| 本地 origin | `github.com/qiansanyu/pi-hashline-edit-pro` |
| 基线分支 | `write-echo` |
| 基线提交 | `dbe01b0`（NEW: Report a line count instead of echoing the file after write） |
| 基线版本 | 7.2.0 |
| `mine` 建立于 | 2026-11-02 |

`mine` 从 `feat/seam-trim`（`b8fe887`）拉出，因此自带下面第 1 项改动。

> 运行时：pi 加载的是 `pi-hashline-edit-pro-lean`，它依赖 `github:qiansanyu/pi-hashline-edit-pro#mine`，落地在
> `~/.pi/agent/git/github.com/qiansanyu/pi-hashline-edit-pro-lean/node_modules/pi-hashline-edit-pro`。
> **`mine` 分支的改动不会自动生效**，生效步骤见文末「如何生效」。

## 变更清单

### 1. `[W_SEAM_TRIMMED]`：替换时裁掉重复的接缝行（`b8fe887`）

**问题**：`replace` 的 `text` 是"新块的样子"，写块必须写它的闭合行；而 `remove_to` 是按"哪些行变了"选的，常常停在最后一条语句而不是块的闭合行。结果闭合行出现两次：`}`、`};`、` */`、javadoc 行重复。

**依据**：一次真实开发会话里 7 次接缝事故，其中 6 次是同一个形状——`text` 末行逐字等于范围外紧邻的存活行，且那一行是闭合行。信息不是瓶颈：那一行就在上一次 `read` 的结果里，模型还是把它排除在范围外。所以这是"写块"和"删行"两套心智模型的分歧，不是算数错误。

**做法**：在锚点解析之后、拼装结果之前，比较 `text` 的首/尾与范围外紧邻的存活行；命中就**从 `text` 里删掉重复行**，而不是扩大 `remove_to`。

**为什么裁 `text` 而不是加宽范围**：两者字节结果完全相同。

| | 加宽 `remove_to` | 裁 `text`（本实现） |
|---|---|---|
| 结果字节 | 相同 | 相同 |
| 存活行锚点 | 作废，重新铸 | **保留原锚点** |
| 范围校验 | 需重跑 `assertRangeServed`（要证明新增的行被展示过） | 不用 |
| 批量重叠判定 | 范围变了，要重算 | 不用 |
| 改动面 | 三个子系统 | 一个数组 |

**分档**（0 误报的关键）：

| 条件 | 行为 |
|---|---|
| 连续 ≥2 行逐字相同 | 裁剪 |
| 1 行，且是闭合行（`}` `};` `});` `)` `*/` `/**` `"""` `'''` `<!--` `-->`） | 裁剪 |
| 1 行普通文本 / 空行 / 整段都重复 | 不裁剪 |
| `insert` / `copy` / `move` / `replace_match` | 不参与（它们的 `text` 本就该原样写） |

判据来自实测：把规则套在本仓库 775 个提交、20,207 个 hunk 的真实编辑上，本分档命中 **0** 次；朴素分档（任意单行重复）命中 32 次（0.16%，全是故意重复的语句，如 `overlay.handleInput("j")` 连按）。

**安全口**：警告写明被裁的行、保留行的锚点、以及规则本身；`strictInput` 下改为 `E_BAD_SHAPE`（不写文件）；`undo_last_change` 可回退。

实际文案：

```text
[W_SEAM_TRIMMED] Dropped 1 repeated row below the range (spfed│ "            }") from "text": the file already keeps that row. A closing line your text writes must sit inside remove_to — widen the range if you meant to replace it.
```

**涉及文件**：

| 文件 | 变更 |
|---|---|
| `src/hashline/seam.ts` | 新增：`trimSeamDuplicates` / `isSeamCloser` |
| `src/hashline/apply.ts` | `planEdit` 增加 `seamTrim` 选项；`PlannedEdit` 与 `applyEdit` 返回应用后的 `edit` |
| `src/hashline/index.ts` | 导出新模块 |
| `src/replace.ts` | 只在 `replace` 的管道、预览、批量 planner 打开 `seamTrim`；行尾符与增删行数改用应用后的 `edit` |
| `src/edit-common.ts` | `[W_SEAM_TRIMMED]` 加入 `strictInput` 拒收列表 |
| `README.md` | replace 段落、`[W_*]` 表、`strictInput` 行 |
| `test/core/seam-trim.test.ts` | 新增 18 个用例（含"裁 `text` == 加宽范围"的字节等价断言） |
| `test/tools/replace-tool.test.ts` | 3 个工具级用例（含严格模式、普通文本不裁） |
| `test/tools/batch.test.ts` | 1 个批量用例（批内裁剪 + 一次 undo 回滚） |

**验证**：

```bash
npx tsc --noEmit
npx eslint "src/**/*.ts" "index.ts" "test/**/*.ts"
npx vitest run
```

结果：2050 通过 / 2 失败（`test/core/hashline-limit.test.ts`、`test/core/outline-batch.test.ts`；这两个在 `write-echo` 基线上同样失败，与本改动无关）；`src/hashline/seam.ts` 覆盖率 100%。

**已知未覆盖**：

- `text` 尾部重复的是一行普通文本 → 不裁（避免 0.14% 误报；7 次事故里剩这 1 次）。
- 范围偏短但 `text` 没重打任何东西（只留下多余的一行）→ 抓不到。需要注释/括号配平类检查，语言相关且误报高，暂不做。

### 2. `[H_LITERAL_ESCAPE]`：提示自带字符数，不再用换行记法引用字面反斜杠（`6133c8d`）

**问题**：原文案是 `text: "\n" written as literal text` —— 把字面反斜杠直接塞进双引号，而 `"\n"` 正是"换行"的通行记法，且不给字符数。读者无法从 transcript 判断落盘的是 2 个字符 `\` `n` 还是一个换行，只能 `cat -A` / `python repr(bytes)` 复核。同一套说法的 `payloadGuideline` 还宣称 "escapes are decoded once … `\\uXXXX` the literal text"，与实测（参数以值到达、工具逐字写）不符，"读提示推理"这条路因此整条失效。

**做法**：提示改为 `text: 2 chars "\\n" written as literal text` —— 双反斜杠表字面（JSON 记法）并报字符数；guideline 改为指向测量（"以 hint 报的字符数为准"），不再断言层位。

**联动**：这串字同时是另外两段代码的输入，必须一起改，否则静默降级：

| 文件 | 改动 |
|---|---|
| `src/utils.ts` | 新增 `formatLiteralEscape` / `parseLiteralEscape`；提示改用前者 |
| `src/edit-fidelity.ts` | 两个解析正则接受 `N chars` 前缀；捕获后 `parseLiteralEscape` 还原再喂 `includes` 与去重键 —— 不还原则 `(anchor│ col N)` 定位与 `[H_UNICODE_LOST]` 去重**静默**失效 |
| `src/edit-common.ts` | `payloadGuideline` 改为层无关表述 |
| `README.md` | `text` 参数两处、`[H_LITERAL_ESCAPE]` 行的样例与说明 |
| `test/**` | 19 处 hint 断言 + 2 处 guideline 断言 |

lean 侧对应 1 行：`pi-hashline-edit-pro-lean/index.ts` 的 replace guideline，另在 lean 仓库提交。

**验证**：

```bash
npx tsc --noEmit
npx eslint "src/**/*.ts" "test/**/*.ts"
npx vitest run
```

结果：2051 通过 / 1 失败，失败项是既有的 `test/core/hashline-limit.test.ts`（Windows 路径转义，改前的干净树同样失败，与本改动无关）。

**边界**：不动 hint 的触发集合（仍是 `\n` `\t` `\r` `\"` `\uXXXX`），不动 diff 渲染（diff 本就逐字），不动 undo。

## 如何生效

`mine` 不会自动进入运行时。两条路：

1. **本地试跑**（改完重启 pi 才生效）：

   ```bash
   P=~/.pi/agent/git/github.com/qiansanyu/pi-hashline-edit-pro-lean/node_modules/pi-hashline-edit-pro
   cp src/hashline/seam.ts "$P/src/hashline/"
   cp src/hashline/apply.ts src/hashline/index.ts "$P/src/hashline/"
   cp src/replace.ts src/utils.ts src/edit-fidelity.ts src/edit-common.ts "$P/src/"
   cp README.md "$P/"
   ```

2. **长期生效**：把 `mine` 推到 origin，再让 pi 重装 `pi-hashline-edit-pro-lean`（它依赖 `#mine`）。lean 侧 `index.ts` 的改动在 lean 仓库单独提交，同步时一并 `cp index.ts "$L/"`。

## 回退

```bash
git switch write-echo          # 基线分支，不含本地改动
```

本地试跑过的目录重新 `npm install`（或重新 `pi install`）即可还原。

## 维护约定

- 上游更新时优先 `git rebase mine onto write-echo`；冲突高发文件：`src/replace.ts`、`src/hashline/apply.ts`，其次是 `README.md`（`[W_*]` 表）。
- 每个本地改动单独一节并标注提交号；被上游采纳后标注「已上游」并删掉该节。
- 上游未配置 remote，需要同步时：

  ```bash
  git remote add upstream https://github.com/YuGiMob/pi-hashline-edit-pro.git
  ```

## 待办

- [ ] 把 `[W_SEAM_TRIMMED]` 提给上游（PR 里附 20,207 hunk 的误报实测与 7 次真实事故复盘）。
- [ ] 评估第二档检测：「注释定界符 per-span delta 配平」，不做全文件配平。
- [ ] 观察真实会话里 `[W_SEAM_TRIMMED]` 的触发率，若普通文本行的漏检变多再放宽分档。
